# Guard the whole GitHub read deadline

[Pull request #86](https://github.com/melian-agent/melian/pull/86) addresses Melian finding 5bb8066fe1155c60. Doctor tests now return response headers and then stall JSON body parsing for both identity and permission reads. Advancing ten seconds must return exit 0, warn and abort the transport.

Stopping the deadline when permission headers arrive must fail the permission-body test. The existing hanging-fetch tests remain.
