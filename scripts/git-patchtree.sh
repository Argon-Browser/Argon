#
# taken from ./scripts/check-patchfail.sh
#
# script: reuse one clean git base tree with worktree + reset instead of re-extracting/re-init per patch
#

set -euo pipefail

if [ ! -f version ]; then
    echo "error: 'version' does not exist. Are you in the right folder?"
    exit 1
fi
ver="$(cat version)"
firefox="firefox-${ver}.source.tar.xz"
if [ ! -f "$firefox" ]; then
    echo "error: '$firefox' does not exist."
    exit 1
fi

patch_arg="${1:-}"
if [ -z "$patch_arg" ] || [ ! -f "$patch_arg" ]; then
    echo "git-patchtree.sh: error, first argument must be a patch file"
    exit 1
fi

root_dir="$(pwd)"
patch_abs="$(cd "$(dirname "$patch_arg")" && pwd)/$(basename "$patch_arg")"
cache_root="${ARGON_PATCHTREE_CACHE:-$root_dir/.cache/patchtree}"
base_repo="$cache_root/base-${ver}"
stamp_file="$cache_root/base-${ver}.stamp"
workdir="$root_dir/firefox-${ver}"

tarball_stamp="$(stat -c '%Y:%s' "$firefox" 2>/dev/null || wc -c < "$firefox")"
git_user_name="${GIT_AUTHOR_NAME:-$(git config --get user.name 2>/dev/null || printf 'Argon Build')}"
git_user_email="${GIT_AUTHOR_EMAIL:-$(git config --get user.email 2>/dev/null || printf 'build@argon.local')}"

base_commit=""
if [ -d "$base_repo/.git" ] && [ -f "$stamp_file" ] && [ "$(cat "$stamp_file")" = "$tarball_stamp" ]; then
    base_commit="$(git -C "$base_repo" rev-parse --verify base^{commit} 2>/dev/null || true)"
fi

if [ -z "$base_commit" ]; then
    echo "Extracting '$firefox' once into cached base repo..."
    rm -rf "$base_repo" "$stamp_file"
    tmp_extract="$cache_root/extract-${ver}-$$"
    rm -rf "$tmp_extract"
    mkdir -p "$tmp_extract"
    tar xf "$firefox" -C "$tmp_extract"
    if [ ! -d "$tmp_extract/firefox-${ver}" ]; then
        echo "error: expected extracted directory 'firefox-${ver}' not found in $firefox" >&2
        rm -rf "$tmp_extract"
        exit 1
    fi
    mv "$tmp_extract/firefox-${ver}" "$base_repo"
    rm -rf "$tmp_extract"

    git -C "$base_repo" init -q
    git -C "$base_repo" config commit.gpgsign false
    git -C "$base_repo" add -A
    git -C "$base_repo" \
        -c commit.gpgsign=false \
        -c user.name="$git_user_name" \
        -c user.email="$git_user_email" \
        commit -q -m "original"
    git -C "$base_repo" branch -M base
    base_commit="$(git -C "$base_repo" rev-parse --verify base^{commit})"
    printf '%s\n' "$tarball_stamp" > "$stamp_file"
fi

reuse_worktree=0
if [ -e "$workdir/.git" ]; then
    work_common="$(git -C "$workdir" rev-parse --git-common-dir 2>/dev/null || true)"
    if [ -n "$work_common" ] && [ "$(cd "$work_common" 2>/dev/null && pwd)" = "$(cd "$base_repo/.git" && pwd)" ]; then
        reuse_worktree=1
    fi
fi

if [ "$reuse_worktree" -eq 1 ]; then
    git -C "$workdir" reset -q --hard "$base_commit"
    git -C "$workdir" clean -q -fdx
else
    rm -rf "$workdir"
    git -C "$base_repo" worktree prune
    git -C "$base_repo" worktree add -q --detach "$workdir" "$base_commit"
fi

(
    cd "$workdir"
    patch --no-backup-if-mismatch -p1 -i "$patch_abs"
    git add -u
    new_paths="$(git ls-files --others --exclude-standard | grep -vE '\.(orig|rej)$' || true)"
    if [ -n "$new_paths" ]; then
        printf '%s\n' "$new_paths" | xargs -d '\n' git add --
    fi
    git \
        -c commit.gpgsign=false \
        -c user.name="$git_user_name" \
        -c user.email="$git_user_email" \
        commit -q -m "patch"
    echo ""
    echo "git-patchtree: Modified files under git control:"
    git diff --name-only "$base_commit" HEAD
)
