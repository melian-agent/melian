# Working in Triage

Triage sorts a linter's findings for a pull request.

## Code

- Behaviour belongs to the object it is about. A function whose first parameter is a `Finding` is a method of `Finding`, whether it asks the finding something, changes it, or formats it.
- Import Node's built-in modules with the `node:` prefix.
