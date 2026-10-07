# Archive refusal tests

For [pull request #89](https://github.com/melian-agent/melian/pull/89), deleting each traversal, absolute-path, no-follow, duplicate-binary and archive-end guard fails its regression. A symlink target has identical bytes, so only the no-follow guard rejects it. Embedded NUL names now fail when bytes follow the terminator; standard zero padding remains valid. All fifteen archive tests pass after restoration.
