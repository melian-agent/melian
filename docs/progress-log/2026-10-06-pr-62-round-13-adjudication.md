The thirteenth review of [pull request #62](https://github.com/melian-agent/melian/pull/62) found that fresh triage could resume a pending adjudication after its lenses finished. The decision commit now removes that adjudication from the review index. The sweep aborts unnamed adjudications before waiting.

The SQLite crash regression holds triage while it checks that the old adjudication wrote no verdict. It then releases triage, checks the replacement correctness run at quick, and confirms its verdict survives another resume.
