# A prompt string in a listed source file draws the notice and no injection finding

The root `melian.yaml` lists `src/prompts.ts` as an instruction file, and the change rewrites the lens brief it holds. A lens reads the new string as an attempt to steer it and reports `melian/injection-attempt`. The finding resolves `silent`, naming the notice in its place, and the notice resolves `acknowledge` and quotes the finding's rule, line and headline. A maintainer still reads the flagged text, once, on the notice.
