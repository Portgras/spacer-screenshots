# Spacer screenshots

The App Store screenshot pipeline for [Spacer](https://apps.apple.com/app/id6778286207).
It captures the app on iPhone and iPad simulators in every language, frames
each screen with its headline, and uploads the listing and screenshots to App
Store Connect.

The app's source lives in a private repo. Everything here is copied from it by
`npm run screenshots`, so edit it there, not here.

The app is downloaded from EAS at run time. Running this needs these secrets:
`EXPO_TOKEN`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`.
