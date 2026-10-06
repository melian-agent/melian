# Getter call identity

Confirmed second-round finding 0f20265ce471b80c on [pull request #89](https://github.com/melian-agent/melian/pull/89). The compiler probe named Box.result instead of alpha. Accessors still own calls in their bodies. A function-valued accessor now falls through to the resolved call signature. The regression fails before the fix.
