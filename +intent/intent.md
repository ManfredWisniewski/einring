# Intent

The intent of this project is to develop an App that shall provide a UI to manage different services and will interface with many other systems via API.

Authentication: via Nextcloud and / or OpenID (Authentik)

It should be possible to deploy the App to android and iOS. For now we will only develop for Android but Deploying to iOS shall always remain a possibility. If it is possible to have a WebApp version of the App as well that can be deployed on a server and accessed via a browser that would be great.

The UI of the app shall be based on tokens defined by the the Style Dictionary system  https://styledictionary.com/
and compatible with the compatible with Design Tokens Community Group spec. https://tr.designtokens.org/format/

Tokens can be pre-generated via https://www.designsystems.one/tools/token-generator

## Name

**einring** - "one ring to control them all"; norse naming consistent with related WIT projects. Android ID `de.wit.einring`.

## Guidance

Architecture decisions: `decisions.md`. Test strategy and acceptance criteria: `tests.md`.

Shared WIT guidance: `+wit/README.md` and `+wit/AGENTS.md`.
