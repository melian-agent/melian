# Tally design

## Export

`toCsv` writes one line per item: its name, then its price in dollars.

Prices are whole cents. A fraction of a cent rounds to the nearest cent, and a half rounds up, as `Math.round` does.
