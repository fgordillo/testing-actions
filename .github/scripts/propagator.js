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
        
        // Define arguments for 'gh pr list'
        const listArgs = [
            "pr", "list",
            "--base", target,
            "--head", newBranch,
            "--repo", context.repo.owner + "/" + context.repo.repo,
            "--json", "number"
        ]

        try {
            await exec.exec("gh", listArgs, {
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
            // Define arguments for 'gh pr create'
            const body = isConflict ?
                `Auto PR: **${source}** to **${target}**.\n\n⚠️ **MERGE CONFLICTS DETECTED** ⚠️` :
                `Auto PR: **${source}** to **${target}**.\n\n✅ **MERGE SUCCESSFUL** ✅`
            const createArgs = [
                "pr", "create",
                "--base", target,
                "--head", newBranch,
                "--title", `Propagate: ${source} → ${target}`,
                "--body", body,
            ]

            let createOutput = ""
            let createError = ""
            
            try {
                await exec.exec("gh", createArgs, {
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

                    // Add label using the API object
                    core.info("Adding 'propagator' label via API...")
                    try {
                        await github.rest.issues.addLabels({
                            owner: context.repo.owner,
                            repo: context.repo.repo,
                            issue_number: parseInt(prNumber),
                            labels: ['propagator'],
                        })
                    } catch (labelError) {
                        core.warning(`Failed to add label to PR #${prNumber}: ${labelError.message}`)
                    }
                } else {
                    core.warning("PR created but could not parse number from output.")
                    core.debug(createOutput)
                }

            } catch (error) {
                core.error(`Failed to create PR. CLI Error Output: ${createError.trim()}`)
                core.setFailed(`gh pr create failed: ${error.message}`)
                return
            }
        }
    })

// ----------------------------------------------------
// 🛠️ FIX: Fetch Conflict Diff and Inject into Prompt
// ----------------------------------------------------
    if (isConflict && prNumber && OPENAI_API_KEY) {
        core.startGroup("🤖 Triggering AI Conflict Review")

        // 1. Fetch the unified diff of the Pull Request (which includes conflict markers)
        let conflictDiff = ""
        try {
            const { data: pullRequest } = await github.rest.pulls.get({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: parseInt(prNumber),
                mediaType: {
                    format: 'diff' // Request the unified diff format
                }
            })
            // The response for mediaType: diff is the diff content as a string
            conflictDiff = pullRequest
            core.info(`Successfully fetched diff content for PR #${prNumber}.`)
            // core.debug(`Diff content:\n${conflictDiff}`)

        } catch (error) {
            core.warning(`Failed to fetch PR diff for AI analysis: ${error.message}`)
            // Fallback: continue with the generic prompt, but warn
        }
        
        const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

        const promptContext = `
            # Merge Conflict Review Instructions
            You are an expert Git Conflict Resolution Agent. Your goal is to analyze the merge conflict present in the following Pull Request: #${prNumber}.
            The PR attempts to merge the source branch **${source}** into the target branch **${target}**.
            
            Analyze the provided Git conflict markers below. **DO NOT invent file names or line numbers.** Base your analysis strictly on the content provided in the conflict diff.

            --- CONFLICT DIFF START ---
            ${conflictDiff}
            --- CONFLICT DIFF END ---

            Your analysis must include:
            1. An explanation of *why* the conflict occurred, mentioning the files and the content lines involved.
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
                issue_number: parseInt(prNumber),
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