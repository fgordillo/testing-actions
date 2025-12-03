#!/bin/bash
# .github/scripts/propagation.sh

set -e

SOURCE="${GITHUB_REF_NAME}"
TARGET=""

# --- 1. Determine target branch (The order of propagation) ---
case "${SOURCE}" in
    # Propagation order: main -> release57 -> fundae -> dev
    main) TARGET="release57" ;;
    release57) TARGET="fundae" ;;
    fundae) TARGET="dev" ;;
    # If the source branch is not configured for propagation, exit cleanly
    *) echo "target=" >> $GITHUB_OUTPUT ; exit 0 ;;
esac

echo "target=${TARGET}" >> $GITHUB_OUTPUT
echo "Source branch: ${SOURCE}"
echo "Target branch: ${TARGET}"

# --- 2. Configure git environment ---
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

TS=$(date +"%Y%m%d-%H%M%S")
BRANCH="auto-propagation/${TS}-${SOURCE}-to-${TARGET}"

# --- 3. Fetch branches ---
# Fetch all relevant branches to ensure local refs are updated
git fetch origin "${TARGET}"
git fetch origin "${SOURCE}"

# Delete the propagation branch if it somehow already exists remotely (for cleanup)
git push origin --delete "${BRANCH}" 2>/dev/null || true

# --- 4. Create propagation branch from target branch ---
git checkout -b "${BRANCH}" "origin/${TARGET}"

# Store the hash of the TARGET branch before attempting the merge
TARGET_HEAD_BEFORE_MERGE=$(git rev-parse HEAD)

# --- 5. Attempt to merge source into the new branch ---
if git merge "origin/${SOURCE}" --no-edit; then
    # Merge successful (No conflict)
    
    # NEW CHECK: Verify if HEAD changed after the merge.
    # If HEAD is the same, no commit was created (merge was a no-op).
    if [ "$(git rev-parse HEAD)" = "$TARGET_HEAD_BEFORE_MERGE" ]; then
        echo "Merge successful, but no changes detected (source branch already merged into target). Skipping PR."
        # Cancel PR creation by setting 'target' to empty, which stops the next YAML step
        echo "target=" >> $GITHUB_OUTPUT 
        exit 0
    fi

    echo "Merge successful (New commit created)"
    echo "conflict=false" >> $GITHUB_OUTPUT
    # Push the successfully merged branch
    git push origin "${BRANCH}"
else
    # Conflict detected
    echo "Merge failed (Conflict detected)"
    echo "conflict=true" >> $GITHUB_OUTPUT

    # Revert to target state to clear any previous merge attempt artifacts
    git reset --hard "origin/${TARGET}"
    # Attempt merge again to get the conflict markers in the working directory.
    # We use '|| true' because this command will intentionally fail (exit code 1), but we want the script to continue.
    git merge "origin/${SOURCE}" --no-commit || true 

    # 🛠️ FIX: Stage the conflicted files so Git knows to commit them with the markers.
    git add .

    # Commit the conflicted state
    git commit -m "Auto-propagation merge (CONFLICT) ${SOURCE} into ${TARGET}"

    # Push the conflicted branch
    git push origin "${BRANCH}"
fi

echo "branch=${BRANCH}" >> $GITHUB_OUTPUT