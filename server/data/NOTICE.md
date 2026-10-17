# Model capability data and adaptation references

`models-dev.json` is an allowlisted snapshot derived from <https://models.dev/api.json>.
Its `source` records the retrieval time and SHA-256 of the original response. Only model
facts are retained; package names, headers, request bodies and executable settings are
discarded. Models.dev is MIT licensed; see `models-dev.LICENSE`.

The thinking-level and protocol compatibility mapping in `provider-reasoning.ts`,
`provider-opencode.ts` and `model-catalog.ts` follows the public contracts of
`@earendil-works/pi-ai` 1.0.4, especially `thinkingLevelMap`, `thinkingFormat`,
`requiresReasoningContentOnAssistantMessages` and the bounded token budget presets.
Source: <https://github.com/earendil-works/pi/tree/main/packages/ai>.
Pi is MIT licensed; see `pi-ai.LICENSE`. Pi's SDK is loaded by the user's Pi Harness,
not bundled as a new Tuantuan request transport dependency.
The extension reads the installed engine's public `getSupportedThinkingLevels` API;
the reference version above is provenance, not a maximum engine version or level list.

Update the bundled data explicitly with `bun run models:update`. The desktop/web
client's manual sync instead stores a validated snapshot in the local database.
Neither operation modifies provider credentials or native Harness configuration.
