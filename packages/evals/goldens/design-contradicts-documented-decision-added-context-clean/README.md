# design-contradicts-documented-decision-added-context-clean

The head adds one line when every lens carries a note, which changes how far the reader can trust a pass, and still states each note once. The base design forbids stating a fact once per lens, not adding context. The scripted design lens over-reports the added line, and the scripted verifier refutes it, so the review reports nothing. Live, either the lens stays silent or the verifier refutes.
