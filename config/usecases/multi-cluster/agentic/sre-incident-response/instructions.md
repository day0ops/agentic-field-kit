# Instructions

## URL to onboard Entra identity on Keycloak

```
https://keycloak.mesh-demo.kasunt.apac.fe.solo.io/realms/sre-irs/protocol/openid-connect/auth?client_id=account-console&redirect_uri=https%3A%2F%2Fkeycloak.mesh-demo.kasunt.apac.fe.solo.io%2Frealms%2Fsre-irs%2Faccount%2F&response_type=code&scope=openid&kc_idp_hint=entra

https://keycloak.mesh-demo.kasunt.apac.fe.solo.io/realms/sre-irs/protocol/openid-connect/auth?client_id=account-console&redirect_uri=https%3A%2F%2Fkeycloak.mesh-demo.kasunt.apac.fe.solo.io%2Frealms%2Fsre-irs%2Faccount%2F&state=80ca925c-853f-4581-b7ec-b714ec93fef7&response_mode=query&response_type=code&scope=openid&nonce=d61e4670-1084-4b94-a510-bc20765eefca&code_challenge=xxTzpUldabPog8NELv0uwLAmIsOAZFWPEyUpG_wFDoo&code_challenge_method=S256&kc_idp_hint=entra
```

## Some test prompts

> A prompt that goes straight to get_deployment_history without needing the incident framing: `What deployments have happened recently for checkout-api?` or `Show me the deployment history for checkout-api`.

> A prompt for incodent-mcp `why is checkout failing?`.