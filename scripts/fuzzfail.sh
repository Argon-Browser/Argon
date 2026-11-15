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

root_dir="$(pwd)"
cache_root="${ARGON_PATCHTREE_CACHE:-$root_dir/.cache/patchtree}"
base_repo="$cache_root/base-${ver}"
stamp_file="$cache_root/base-${ver}.stamp"
tmpdir="$root_dir/tmpdir92"
ff_dir="firefox-${ver}"
apply_tree="$tmpdir/$ff_dir"

cleanup() {
    if [ -d "$base_repo/.git" ]; then
        git -C "$base_repo" worktree remove --force "$apply_tree" >/dev/null 2>&1 || true
        git -C "$base_repo" worktree remove --force "$root_dir/$ff_dir" >/dev/null 2>&1 || true
        git -C "$base_repo" worktree prune >/dev/null 2>&1 || true
    fi
    rm -rf "$tmpdir" "$root_dir/$ff_dir"
}
trap cleanup EXIT

# Reuse/populate the cached git base tree once before attaching the clean apply worktree.
tarball_stamp="$(stat -c '%Y:%s' "$firefox" 2>/dev/null || wc -c < "$firefox")"
if [ ! -d "$base_repo/.git" ] || [ ! -f "$stamp_file" ] || [ "$(cat "$stamp_file")" != "$tarball_stamp" ]; then
    git_user_name="${GIT_AUTHOR_NAME:-$(git config --get user.name 2>/dev/null || printf 'Argon Build')}"
    git_user_email="${GIT_AUTHOR_EMAIL:-$(git config --get user.email 2>/dev/null || printf 'build@argon.local')}"
    rm -rf "$base_repo" "$stamp_file"
    tmp_extract="$cache_root/extract-${ver}-$$"
    rm -rf "$tmp_extract"
    mkdir -p "$tmp_extract"
    tar xf "$firefox" -C "$tmp_extract"
    mv "$tmp_extract/$ff_dir" "$base_repo"
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
    printf '%s\n' "$tarball_stamp" > "$stamp_file"
fi

rm -rf "$tmpdir"
mkdir -p "$tmpdir"
git -C "$base_repo" worktree prune >/dev/null 2>&1 || true
git -C "$base_repo" worktree add -q --detach "$apply_tree" base

while IFS= read -r curpatch || [ -n "$curpatch" ]; do
    [ -z "$curpatch" ] && continue
    case "$curpatch" in
        \#*) continue ;;
    esac

    if ! (cd "$apply_tree" && patch --fuzz=0 -p1 -i "$root_dir/$curpatch" > "$tmpdir/patch.tmp") || grep -q 'rej$' "$tmpdir/patch.tmp"; then
        echo "$curpatch"
        (
            cd "$root_dir"
            scripts/git-patchtree.sh "$curpatch"
            cd "$ff_dir"
            git diff "$(git rev-list --max-parents=0 HEAD)" HEAD > "../$curpatch.nofuzz"
        )
    fi

    rm -f "$tmpdir/patch.tmp"
done < "$root_dir/assets/patches.txt"
