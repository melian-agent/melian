# pr-summary

Posts a summary comment on each pull request. The workflow runs on `pull_request_target`, so it holds a token that can write to the repository, and checks out the pull request's head into `pr/`. The pull request supplies everything under `pr/`, including its `.summary/` folder.
