# Timestamps in the API are UTC

Choice: Every timestamp the API returns is a UTC ISO 8601 string ending in `Z`, because clients in several time zones sort and compare them as text.
