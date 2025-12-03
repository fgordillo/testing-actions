#!/bin/bash
# .github/scripts/propagation.sh

set -e

SOURCE="${GITHUB_REF_NAME}"
TARGET=""

case "${SOURCE}" in
    main) TARGET="release57" ;;
    release57) TARGET="fundae" ;;
    fundae) TARGET="dev" ;;
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

# --- 5. Attempt to merge source into the new branch ---
if git merge "origin/${SOURCE}" --no-edit; then
    echo "Merge successful (No conflict)"
    echo "conflict=false" >> $GITHUB_OUTPUT
    # Push the successfully merged branch
    git push origin "${BRANCH}"
else
    # Conflict detected
    echo "Merge failed (Conflict detected)"
    echo "conflict=true" >> $GITHUB_OUTPUT

    # Abort the merge to keep the branch clean but containing the merge result markers
    # The conflict markers are needed for the AI review script
    # DO NOT abort the merge here. We need the conflict markers to be visible in the PR diff.
    # The merge should be committed locally with conflicts, and then pushed.

    # Revert to target state, then attempt merge again to get the conflict markers for the diff
    git reset --hard "origin/${TARGET}"
    git merge "origin/${SOURCE}" --no-commit # Perform merge without committing

    # Commit the conflicted state
    git commit -m "Auto-propagation merge (CONFLICT) ${SOURCE} into ${TARGET}"

    # Push the conflicted branch
    git push origin "${BRANCH}"
fi

echo "branch=${BRANCH}" >> $GITHUB_OUTPUT
