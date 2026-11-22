# Build with a builder

`implement-pr` and `implement-spec-stack` read this file when `review.ts builder` prints a builder for the ticket they build. The **builder** is the `{alias, provider, model, effort}` that `review.ts builder` printed. `provider` is a T3 Code provider instance id. The builder writes the code of the ticket in place of your own model, and you never write or change a line of its code.

When a check below fails, stop, by the stop rule of the skill that sent you here, with a message that names the builder and the cause. Nothing is then built on your own model.

1. **The tool.** Load `delegate_task` and `orchestrator_capabilities` (ToolSearch `select:mcp__t3-code__delegate_task,mcp__t3-code__orchestrator_capabilities`). With no `delegate_task`, stop: `builder <alias>: this session has no delegate_task tool`.
2. **The target.** Call `orchestrator_capabilities`. Its short list leaves models out, so when the model is not in it, call it again with `search: "<model>"`. The provider instance must be there, with `canRunChildTask` true and no `constraints`. The model must be in its catalog. The model's effort option must list the builder's `effort`: read the option id from the catalog (`reasoningEffort` on Codex, `effort` on Claude today), never assume it. When one of these is not so, stop and name it: the provider, the model or the effort.
3. **The brief.** Write the task for the builder. It gets only this text, with no history and no skills:
   - the ticket (its URL, and `gh issue view <ticket>` to read it), and its parent spec when it has one;
   - the absolute path of the worktree and its branch. It works only there: `cd <path>` first, and `git rev-parse --show-toplevel` must print that path;
   - build the ticket test-first, at the seams the ticket names: one failing test, then the code that passes it, one behaviour at a time, through public interfaces only. Give it the path of `<the folder this file is in>/../tdd/SKILL.md` to read;
   - the repo's typecheck and test commands;
   - it commits nothing, pushes nothing, opens no PR, and starts no agent;
   - its report: the files it changed, the test runs with their output, and each choice the ticket left open, with the options and the reason. It asks no question. At a one-way door (a data shape, a public API, a new dependency, a migration, or a destructive action) it stops, writes no more code, and reports the question and the options.

   On a re-run after an interrupted session, the brief also says what is built already and what is still missing.
4. **Start it.** Call `delegate_task` with `target: {providerInstanceId: <provider>, model: <model>, options: {<effort option id>: <effort>}}`, `isolation: "shared"`, `mode: "async"`, `role: "implementation"`, and the brief as `task`. Follow its `next` until the builder reports, and do not poll it. When the tool refuses the start (for example, the provider or the model is not available), stop with its message.
5. **Check its work.** Read its report and `git status`, then run the typecheck and the full test suite. When a check fails, start one new `delegate_task` on the same builder, with the same brief and the failing output. When a check still fails after that, stop and report the output: you never fix its code. When both pass, commit its work.
6. **An answer.** When its report holds a one-way door and the skill that sent you here gets the answer, start one new `delegate_task` on the same builder, with the same brief, what it built so far, and the answer. Then check its work again, as step 5 says.

The PR body's Evidence names the builder: `Built by builder <alias>: <model> at <effort> effort (<provider>).`
