# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) (`+wit/common/conventions/changelog.md`); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Android MDM managed configuration: `einring_api_url` restriction schema (`res/xml/app_restrictions.xml` + `APP_RESTRICTIONS` manifest hook) and an `AppConfig` Capacitor plugin; a value pushed by the MDM overrides the baked `VITE_API_URL` at startup, unset keeps the build default — verified target is Samsung Knox Manage (spec `+wit/specs/common/android-appconfig/`, A50).

## [<version>] - <YYYY-MM-DD>

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security
