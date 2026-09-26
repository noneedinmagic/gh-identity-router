#!/usr/bin/env bash

set -euo pipefail

tool_dir="$(cd "$(dirname "$0")" && pwd)"
user_home="${HOME:?HOME is not set}"
bin_dir="$user_home/.local/bin"
share_dir="$user_home/.local/share/gh-multi-account"
state_dir="$user_home/.local/state/gh-multi-account"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$state_dir/backups/$timestamp-$$"
config_path="${MULTI_ACCOUNT_CONFIG:-$user_home/.config/gh-multi-account/config.json}"
verify_command="${MULTI_ACCOUNT_VERIFY_COMMAND:-$tool_dir/src/multi-account-token.mjs}"
dry_run=false
restore_dir=""

target_names=(
  bin-gh
  bin-token
  bin-credential
  bin-mint-dispatch-token
  share-token
  share-example
)
target_paths=(
  "$bin_dir/gh"
  "$bin_dir/multi-account-token"
  "$bin_dir/multi-account-git-credential"
  "$bin_dir/mint-dispatch-token"
  "$share_dir/multi-account-token.mjs"
  "$share_dir/config.example.json"
)
git_config_names=(
  helper
  username
  use-http-path
)
git_config_keys=(
  credential.https://github.com.helper
  credential.https://github.com.username
  credential.https://github.com.useHttpPath
)

usage() {
  echo "Usage: $0 [--dry-run | --restore BACKUP_DIR]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=true
      shift
      ;;
    --restore)
      if [[ $# -lt 2 ]]; then
        usage
        exit 2
      fi
      restore_dir="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if "$dry_run" && [[ -n "$restore_dir" ]]; then
  usage
  exit 2
fi

restore_git_config() {
  local values_file="$1"
  local key="$2"
  local value

  git config --global --unset-all "$key" 2>/dev/null || true
  while IFS= read -r -d '' value; do
    git config --global --add "$key" "$value"
  done <"$values_file"
}

resolve_backup_dir() {
  local selected_backup="$1"
  local backups_root
  local resolved_backup

  if [[ ! -d "$selected_backup" ]]; then
    echo "Backup directory does not exist: $selected_backup" >&2
    return 1
  fi

  backups_root="$(realpath -m -- "$state_dir/backups")"
  resolved_backup="$(realpath -- "$selected_backup")"

  case "$resolved_backup" in
    "$backups_root"/*) printf '%s\n' "$resolved_backup" ;;
    *)
      echo "Refusing backup outside $backups_root" >&2
      return 1
      ;;
  esac
}

restore_backup() {
  local selected_backup
  local index
  local name
  local target

  selected_backup="$(resolve_backup_dir "$1")"

  if [[ ! -f "$selected_backup/manifest.version" ]] \
    || [[ "$(<"$selected_backup/manifest.version")" != "gh-multi-account-backup-v1" ]]; then
    echo "Invalid gh-multi-account backup: $selected_backup" >&2
    return 1
  fi

  if [[ ! -f "$selected_backup/home.path" ]] \
    || [[ "$(<"$selected_backup/home.path")" != "$user_home" ]]; then
    echo "Backup belongs to a different HOME: $selected_backup" >&2
    return 1
  fi

  # Validate the complete snapshot before changing any live file or Git setting.
  for index in "${!target_names[@]}"; do
    name="${target_names[$index]}"
    if [[ ! -e "$selected_backup/files/$name" ]] \
      && [[ ! -L "$selected_backup/files/$name" ]] \
      && [[ ! -f "$selected_backup/files/$name.absent" ]]; then
      echo "Backup is missing file state for $name" >&2
      return 1
    fi
  done

  for index in "${!git_config_names[@]}"; do
    name="${git_config_names[$index]}"
    if [[ ! -f "$selected_backup/git-config/$name.values" ]]; then
      echo "Backup is missing Git config state for $name" >&2
      return 1
    fi
  done

  for index in "${!target_names[@]}"; do
    name="${target_names[$index]}"
    target="${target_paths[$index]}"
    mkdir -p "$(dirname "$target")"

    if [[ -e "$selected_backup/files/$name" || -L "$selected_backup/files/$name" ]]; then
      rm -f -- "$target"
      cp -a "$selected_backup/files/$name" "$target"
    elif [[ -f "$selected_backup/files/$name.absent" ]]; then
      rm -f -- "$target"
    else
      echo "Backup is missing file state for $name" >&2
      return 1
    fi
  done

  for index in "${!git_config_names[@]}"; do
    name="${git_config_names[$index]}"
    if [[ ! -f "$selected_backup/git-config/$name.values" ]]; then
      echo "Backup is missing Git config state for $name" >&2
      return 1
    fi
    restore_git_config \
      "$selected_backup/git-config/$name.values" \
      "${git_config_keys[$index]}"
  done

  echo "Restored gh-multi-account state from: $selected_backup"
}

create_backup() {
  local index
  local name
  local target

  mkdir -p "$backup_dir/files" "$backup_dir/git-config"
  printf '%s\n' "gh-multi-account-backup-v1" >"$backup_dir/manifest.version"
  printf '%s\n' "$user_home" >"$backup_dir/home.path"

  for index in "${!target_names[@]}"; do
    name="${target_names[$index]}"
    target="${target_paths[$index]}"

    if [[ -e "$target" || -L "$target" ]]; then
      cp -a "$target" "$backup_dir/files/$name"
    else
      : >"$backup_dir/files/$name.absent"
    fi
  done

  for index in "${!git_config_names[@]}"; do
    git config --global --null --get-all "${git_config_keys[$index]}" \
      >"$backup_dir/git-config/${git_config_names[$index]}.values" 2>/dev/null || true
  done
}

if [[ -n "$restore_dir" ]]; then
  restore_backup "$restore_dir"
  exit 0
fi

if "$dry_run"; then
  echo "Would back up existing files to: $backup_dir"
  printf 'Would install: %s\n' "${target_paths[@]}"
  echo "Would require a successful live verification using: $config_path"
  echo "Would configure Git credential helper with per-repository paths"
  echo "Would support rollback with: $0 --restore $backup_dir"
  exit 0
fi

if [[ ! -f "$config_path" ]]; then
  echo "Config file does not exist: $config_path" >&2
  exit 1
fi

MULTI_ACCOUNT_CONFIG="$config_path" "$verify_command" --verify
create_backup

rollback_needed=true
on_error() {
  local status=$?

  trap - ERR
  if "$rollback_needed"; then
    echo "Installation failed; restoring previous credential state." >&2
    if ! restore_backup "$backup_dir"; then
      echo "Automatic restore failed; use: $0 --restore $backup_dir" >&2
    fi
  fi
  exit "$status"
}
trap on_error ERR

mkdir -p "$bin_dir" "$share_dir"

install -m 0755 "$tool_dir/bin/gh" "$bin_dir/gh"
install -m 0755 "$tool_dir/bin/multi-account-git-credential" "$bin_dir/multi-account-git-credential"
install -m 0755 "$tool_dir/bin/mint-dispatch-token" "$bin_dir/mint-dispatch-token"
install -m 0755 "$tool_dir/src/multi-account-token.mjs" "$share_dir/multi-account-token.mjs"
install -m 0644 "$tool_dir/config.example.json" "$share_dir/config.example.json"

token_launcher="$(mktemp)"
trap 'rm -f "$token_launcher"' EXIT
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  echo 'exec "$HOME/.local/share/gh-multi-account/multi-account-token.mjs" "$@"'
} >"$token_launcher"
install -m 0755 "$token_launcher" "$bin_dir/multi-account-token"

git config --global --unset-all credential.https://github.com.helper 2>/dev/null || true
git config --global --add credential.https://github.com.helper ""
git config --global --add credential.https://github.com.helper "$bin_dir/multi-account-git-credential"
git config --global credential.https://github.com.username x-access-token
git config --global credential.https://github.com.useHttpPath true

if [[ -n "${MULTI_ACCOUNT_VERIFY_COMMAND:-}" ]]; then
  MULTI_ACCOUNT_CONFIG="$config_path" "$MULTI_ACCOUNT_VERIFY_COMMAND" --verify
else
  MULTI_ACCOUNT_CONFIG="$config_path" "$bin_dir/multi-account-token" --verify
fi

rollback_needed=false
trap - ERR

echo "Installed gh-multi-account-credentials helpers."
echo "Existing files and Git credential settings were backed up to: $backup_dir"
echo "Restore with: $0 --restore $backup_dir"
