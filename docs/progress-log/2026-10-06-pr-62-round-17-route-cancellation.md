# Route cancellation reaches the collection

The seventeenth Melian round on [pull request #62](https://github.com/melian-agent/melian/pull/62) confirmed a test gap at `RouteTextModel.answer`.

The new regression replaces the fake collection's completion method. It records the signal, waits for cancellation, and returns an aborted reply. The test checks signal identity before aborting and checks that the model rejects the aborted reply. Production already forwards the signal and remains unchanged.
