# Renaming skills to dodge Claude Code built-in commands

Skill names are not changed because Claude Code ships a built-in command or skill with the same name (`/prototype`, `/research`, `/code-review`, and so on). Requests to rename a skill, or add an alias, to avoid a collision are out of scope.

## Why this is out of scope

Claude Code adds built-ins all the time and picks its own names. Renaming each time one of them lands on a name we already use would mean chasing a moving target, and it would break every user's muscle memory and every cross-reference between skills each time.

How Claude Code resolves two things with the same name is Claude Code's behaviour, not the skill's. The skill text is correct either way.

The way through is namespaced invocation. The plugin exposes every skill under its plugin name, so you can always reach ours explicitly:

```
/hero-forge:research
/hero-forge:code-review
```

If Claude Code gives you no way to reach a namespaced skill at all, report that to Claude Code.

## Prior requests

These were filed on `mattpocock/skills`, before the hard fork. Some name other harnesses, which hero-forge no longer supports.

- mattpocock/skills#423: "/code-review shadows Claude Code own review skill"
- mattpocock/skills#483: "/code-review name clash with Claude Code built-in"
- mattpocock/skills#857: "Rename the research skill to avoid conflict with Copilot's built-in /research command"
- mattpocock/skills#1019: "Shorthand `/prototype` conflicts with hidden new Claude Code built-in skill `/prototype`"
- mattpocock/skills#1037: "Skill name overlap with devin cli inbuilt commands"
