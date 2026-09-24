# Intent

The intent of this project is to develop an App that shall provide a UI to manage different services and will interface with many other systems via API.

Authentication: via Nextcloud and / or OpenID (Authentik)

It should be possible to deploy the App to android and iOS. For now we will only develop for Android but Deploying to iOS shall always remain a possibility. If it is possible to have a WebApp version of the App as well that can be deployed on a server and accessed via a browser that would be great.

The UI of the app shall be based on tokens defined by the the Style Dictionary system  https://styledictionary.com/
and compatible with the compatible with Design Tokens Community Group spec. https://tr.designtokens.org/format/

## Name

**einring** - "one ring to control them all"; norse naming consistent with related WIT projects. Android ID `de.wit.einring`.

## Guidance

Before making changes, read the shared WIT development guidance in `+wit-dev/` in this repository. Start with `+wit-dev/README.md` and `+wit-dev/AGENTS.md`, then read the relevant convention or best-practice files. These shared definitions apply independently of which skill or AI agent is performing the work.

Architecture decisions: `decisions.md`. Test strategy and acceptance criteria: `tests.md`.
