#!/usr/bin/env bash

set -euo pipefail

tool_dir="$(cd "$(dirname "$0")" && pwd)"
user_home="${HOME:?HOME is not set}"
bin_dir="$user_home/.local/bin"
share_dir="$user_home/.local/share/gh-identity-router"
state_dir="$user_home/.local/state/gh-identity-router"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$state_dir/backups/$timestamp-$$"
config_path="${IDENTITY_ROUTER_CONFIG:-$user_home/.config/gh-identity-router/config.json}"
verify_command="${IDENTITY_ROUTER_VERIFY_COMMAND:-$tool_dir/src/multi-account-token.mjs}"
dry_run=false
restore_dir=""

target_names=(
  bin-gh
  bin-token
  bin-credential
  bin-mint-dispatch-token
  share-token
  share-example
  bin-identity
  share-identity
)
# Targets added after backup format v1 shipped. A backup taken before they existed has
# no file state for them; restore treats that as "was absent" instead of failing.
# ponytail: a damaged new backup missing these entries also reads as absent; add a
# per-backup target list to the manifest if that ever matters.
legacy_missing_ok_names=(
  bin-identity
  share-identity
)
target_paths=(
  "$bin_dir/gh"
  "$bin_dir/multi-account-token"
  "$bin_dir/git-credential-gh-identity-router"
  "$bin_dir/mint-dispatch-token"
  "$share_dir/multi-account-token.mjs"
  "$share_dir/config.example.json"
  "$bin_dir/identity.sh"
  "$share_dir/identity.mjs"
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

is_legacy_missing_ok() {
  local candidate
  for candidate in "${legacy_missing_ok_names[@]}"; do
    [[ "$candidate" == "$1" ]] && return 0
  done
  return 1
}

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
    || [[ "$(<"$selected_backup/manifest.version")" != "gh-identity-router-backup-v1" ]]; then
    echo "Invalid gh-identity-router backup: $selected_backup" >&2
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
      && [[ ! -f "$selected_backup/files/$name.absent" ]] \
      && ! is_legacy_missing_ok "$name"; then
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
    elif [[ -f "$selected_backup/files/$name.absent" ]] || is_legacy_missing_ok "$name"; then
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

  echo "Restored gh-identity-router state from: $selected_backup"
}

create_backup() {
  local index
  local name
  local target

  mkdir -p "$backup_dir/files" "$backup_dir/git-config"
  printf '%s\n' "gh-identity-router-backup-v1" >"$backup_dir/manifest.version"
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

IDENTITY_ROUTER_CONFIG="$config_path" "$verify_command" --verify
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
install -m 0755 "$tool_dir/bin/git-credential-gh-identity-router" "$bin_dir/git-credential-gh-identity-router"
install -m 0755 "$tool_dir/bin/mint-dispatch-token" "$bin_dir/mint-dispatch-token"
install -m 0755 "$tool_dir/src/multi-account-token.mjs" "$share_dir/multi-account-token.mjs"
install -m 0755 "$tool_dir/bin/identity.sh" "$bin_dir/identity.sh"
install -m 0644 "$tool_dir/src/identity.mjs" "$share_dir/identity.mjs"
install -m 0644 "$tool_dir/config.example.json" "$share_dir/config.example.json"

token_launcher="$(mktemp)"
trap 'rm -f "$token_launcher"' EXIT
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  echo 'exec "$HOME/.local/share/gh-identity-router/multi-account-token.mjs" "$@"'
} >"$token_launcher"
install -m 0755 "$token_launcher" "$bin_dir/multi-account-token"

git config --global --unset-all credential.https://github.com.helper 2>/dev/null || true
git config --global --add credential.https://github.com.helper ""
git config --global --add credential.https://github.com.helper gh-identity-router
git config --global credential.https://github.com.username x-access-token
git config --global credential.https://github.com.useHttpPath true

if [[ -n "${IDENTITY_ROUTER_VERIFY_COMMAND:-}" ]]; then
  IDENTITY_ROUTER_CONFIG="$config_path" "$IDENTITY_ROUTER_VERIFY_COMMAND" --verify
else
  IDENTITY_ROUTER_CONFIG="$config_path" "$bin_dir/multi-account-token" --verify
fi

rollback_needed=false
trap - ERR

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Warning: $bin_dir is not on PATH; Git cannot find git-credential-gh-identity-router until it is." >&2 ;;
esac

echo "Installed gh-identity-router helpers."
echo "Existing files and Git credential settings were backed up to: $backup_dir"
echo "Restore with: $0 --restore $backup_dir"
