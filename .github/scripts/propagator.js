const { OpenAI } = require("openai")

module.exports = async ({ github, context, core, exec, target, source, newBranch, isConflict }) => {

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY
    const GH_TOKEN = process.env.GITHUB_TOKEN // Used for gh CLI authentication

    // Check prerequisites
    if (!OPENAI_API_KEY) {
        core.warning("OPENAI_API_KEY secret is missing. AI conflict review will be skipped.")
    }
    if (!GH_TOKEN) {
        core.setFailed("GITHUB_TOKEN secret is missing.")
        return
    }

    // 1. Configure the GitHub CLI (gh)
    core.info("Configuring GitHub CLI...")
    await core.group("GitHub CLI setup", async () => {
        // Set up the token for gh CLI
        core.exportVariable("GH_TOKEN", GH_TOKEN)
    })

    let prNumber = null

    // 2. Attempt to find existing PR or create a new one
    await core.group("Create Pull Request", async () => {

        // --- A. Check for existing PR ---
        let existingPrOutput = ""
        let existingPrError = ""
        const listCmd = [
            "gh", "pr", "list",
            "--base", target,
            "--head", newBranch,
            "--repo", context.repo.owner + "/" + context.repo.repo,
            "--json", "number"
        ]

        try {
            // Use exec.exec to run the command and capture output
            await exec.exec(listCmd.join(" "), [], {
                silent: true,
                listeners: {
                    stdout: (data) => { existingPrOutput += data.toString() },
                    stderr: (data) => { existingPrError += data.toString() }
                }
            })
        } catch (error) {
            core.warning(`Error checking existing PRs: ${existingPrError.trim()}`)
            // Don't throw here, proceed to attempt PR creation
        }

        let existingPrs = []
        try {
            existingPrs = JSON.parse(existingPrOutput || "[]")
        } catch (e) {
            core.debug("No valid JSON returned from PR list")
        }

        if (existingPrs.length > 0) {
            prNumber = existingPrs[0].number
            core.info(`Existing PR found: #${prNumber}`)
        } else {
            // --- B. Create new PR ---
            const createCmd = [
                "gh", "pr", "create",
                "--base", target,
                "--head", newBranch,
                "--title", `Propagate: ${source} → ${target}`,
                "--body", `Auto PR: **${source}** to **${target}**.\n\n${isConflict ? '⚠️ **MERGE CONFLICTS DETECTED** ⚠️' : '✅ **MERGE SUCCESSFUL** ✅'}`,
                "--label", "propagator" 
            ]

            let createOutput = ""
            let createError = ""
            
            try {
                // Use exec.exec to run the command and capture output
                await exec.exec(createCmd.join(" "), [], {
                    listeners: { 
                        stdout: (data) => { createOutput += data.toString() },
                        stderr: (data) => { createError += data.toString() }
                    }
                })

                // Extract PR number from output URL
                const match = createOutput.match(/\/pull\/(\d+)/)
                if (match) {
                    prNumber = match[1]
                    core.info(`PR successfully created: #${prNumber}`)
                } else {
                    core.warning("PR created but could not parse number from output.")
                    core.debug(createOutput)
                }

            } catch (error) {
                // This catch handles 'gh pr create' failing (e.g., due to an unknown label, or if
                // propagator.sh failed to detect a 'no-op' merge, although the shell script now handles that).
                core.error(`Failed to create PR. CLI Error Output: ${createError.trim()}`)
                core.setFailed(`gh pr create failed: ${error.message}`)
                return
            }
        }
    })

    // 3. Trigger AI review on conflict
    if (isConflict && prNumber && OPENAI_API_KEY) {
        core.startGroup("🤖 Triggering AI Conflict Review")

        const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

        const promptContext = `
            # Merge Conflict Review Instructions
            You are an expert Git Conflict Resolution Agent. Your goal is to analyze the merge conflict present in the following Pull Request: #${prNumber}.
            The PR attempts to merge the source branch **${source}** into the target branch **${target}**.

            Use the GitHub API (if needed) and the context of the diff to explain the conflict to the developer.

            Your analysis must include:
            1. An explanation of *why* the conflict occurred (which files/lines are involved).
            2. A recommendation on *how* to resolve the conflict (which change should be kept, or if a hybrid solution is needed).
            3. A warning that manual intervention is required.

            Generate the output as a detailed Markdown comment to be posted on the PR.
        `
        core.info("Sending conflict prompt to OpenAI...")

        try {
            const completion = await openai.chat.completions.create({
                model: "gpt-4-turbo",
                messages: [{ role: "user", content: promptContext }],
                temperature: 0.2,
            })

            const llmReview = completion.choices[0].message.content

            // Post the result as a comment on the Pull Request
            await github.rest.issues.createComment({
                issue_number: prNumber,
                owner: context.repo.owner,
                repo: context.repo.repo,
                body: `## ⚠️ AI Conflict Analysis (GPT-4) ⚠️\n\n${llmReview}`
            })
            core.info(`AI review posted to PR #${prNumber}.`)

        } catch (error) {
            core.warning(`OpenAI API call failed during conflict review: ${error.message}`)
        }
        core.endGroup()
    } else if (isConflict && !OPENAI_API_KEY) {
        core.warning("Merge conflict detected, but OPENAI_API_KEY is missing. Skipping AI review.")
    }
}