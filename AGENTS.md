### Instructions

Don't create multiple files for one test . if you have to try multiple ways, just add cases in the same test file and refer it via function call
You can refer to examples folder for testing
Also whenever you feel you made a new change just push the code
Also Add docs for every step whenever you make a change and test it

Whenever you add a new tool in agents folder, use ./skill-creator/creator/Skill.md to create relevant built-in skill

### Prompt-vs-Skill Contract

- Skill: an executable capability/procedure the agent knows how to perform.
- Prompt: a reusable reference scaffold used to improve framing, questions, and output structure.
- Do not duplicate skill instructions with prompt text.
- Prefer skills for execution; use prompts only when they add net-new guidance.