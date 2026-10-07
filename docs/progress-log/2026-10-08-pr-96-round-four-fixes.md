# Pull request 96, round four fixes

Round four of Melian's review of step 14 raised three findings. Commit 6306386b makes the walkthrough credential test call the unlock it is handed and count the credential runs. Commit 0dad3610 stores the golden names beside the model and has the comparison refuse a baseline of another model or golden set, reading means within 0.005 as equal. Commit 486b209d fails the record gate on CI when main cannot be read; it fetches main in the workflow and tells a missing record from an unreadable main.
