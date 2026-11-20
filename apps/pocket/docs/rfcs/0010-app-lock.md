---
rfc: "0010"
title: "Optional app lock"
status: Draft
created: 2026-11-19
pr: ""
---
# RFC 0010 — Optional app lock

## Summary

Turn on **Settings → Alerts → Lock Automagik** to require Android authentication when Pocket
starts and after 60 seconds away. With the lock on, alert notifications report only that an
agent needs you or finished. Open Automagik to answer.

## Motivation

Protect paired machines from someone holding an unlocked phone. Opening Pocket can expose
terminal and chat content and let that person send input to the machines.

## Design

- **Set the lock.** It starts off. Turning it on requires a secure Android screen lock, and
  changing it either way requires successful authentication. If the screen lock is removed
  later, the cover stays up and links to Android security settings. Set a screen lock there,
  return, and unlock. If you cannot set one, clear Automagik's storage in Android settings and
  pair again. Clearing storage removes the app's local data.
  `android/app/src/main/java/ai/namastex/automagik/MainActivity.kt:119`
  `android/app/src/main/java/ai/namastex/automagik/AppLock.kt:272`
- **Count time off screen.** Start locked in each new process when the `app_lock` preference
  is on. Count started activities across Main, Assist and the scanner. When the last stops,
  start the 60-second interval using Android's monotonic elapsed time. A screen turning off
  stops the visible activity and starts the same interval. A visible split-screen window
  keeps the app unlocked. Check the interval before the first activity starts counting again.
  Each relock starts one episode and allows one automatic prompt across both entry points.
  `android/app/src/main/java/ai/namastex/automagik/AppLock.kt:51`
  `android/app/src/main/java/ai/namastex/automagik/CrashLog.kt:17`
- **Authenticate with Android.** On API 30 and later, the platform biometric prompt accepts
  fingerprint, face or a screen lock. Below API 30, the system credential screen accepts a
  PIN, pattern or password. The normal `USE_BIOMETRIC` permission enables the prompt. Android
  handles the authentication data. Cancel a biometric prompt when its activity stops. A
  credential result can return after recreation in the same process. Only the current attempt
  can complete, and a cancellation leaves the setting and cover as they were.
  `android/app/src/main/AndroidManifest.xml:6`
  `android/app/src/main/java/ai/namastex/automagik/AppLock.kt:171`
- **Cover app content.** Remove screens, dialogs and web views from composition while locked.
  Close the keyboard and clear focus. Pairing links still make an offer, which needs a tap to
  confirm after unlock. Alert taps select the agent for after unlock. Drop locked scan results
  and clear the re-pair target. Hold one update tap in memory until unlock. After recreation,
  tap the update notification again. Installer and permission effects run while the app is
  open after unlock.
  `android/app/src/main/java/ai/namastex/automagik/MainActivity.kt:83`
  `android/app/src/main/java/ai/namastex/automagik/MainActivity.kt:105`
  `android/app/src/main/java/ai/namastex/automagik/MainActivity.kt:133`
  `android/app/src/main/java/ai/namastex/automagik/MainActivity.kt:177`
  `android/app/src/main/java/ai/namastex/automagik/PocketViewModel.kt:360`
- **Cover Assist.** While the app lock is enabled, show the cover if either the app or the
  phone is locked. On the Unlock tap, dismiss Android's lock screen first, then check whether
  the app still needs authentication. On API 26, open Assist after unlocking the phone. Check
  the app lock again before sending from Assist.
  `android/app/src/main/java/ai/namastex/automagik/AssistActivity.kt:49`
  `android/app/src/main/java/ai/namastex/automagik/AssistActivity.kt:82`
- **Protect Recents.** With the lock enabled, Android omits Recents screenshots on API 33 and
  later. On API 26–32, secure windows also block screenshots and screen sharing. This applies
  to every window in the app, including the scanner. A scanner that starts while locked closes.
  `android/app/src/main/java/ai/namastex/automagik/AppLock.kt:138`
  `android/app/src/main/java/ai/namastex/automagik/CrashLog.kt:20`
- **Keep alerts generic.** Enablement clears posted Needs you and Done alerts. It leaves the
  Watch notification available. While enabled, alerts have no actions, and both receivers
  refuse stale actions. An answer already admitted before enablement can finish, with a
  generic outcome if the lock is enabled by then. With the lock off, the existing action
  authentication and visibility follow **Answer from the lock screen**.
  `android/app/src/main/java/ai/namastex/automagik/Notify.kt:68`
  `android/app/src/main/java/ai/namastex/automagik/Notify.kt:75`
  `android/app/src/main/java/ai/namastex/automagik/Notify.kt:84`
  `android/app/src/main/java/ai/namastex/automagik/Notify.kt:94`
  `android/app/src/main/java/ai/namastex/automagik/Notify.kt:122`
- **Keep Watch working.** A visible cover counts as foreground for Watch and updates, without
  starting terminal or chat streams. The previously selected agent still counts as on screen
  for alerts, so its Needs you plays the in-app sound in place of a notification.
  `android/app/src/main/java/ai/namastex/automagik/AppLock.kt:278`
  `android/app/src/main/java/ai/namastex/automagik/PocketViewModel.kt:542`

With the app lock off, Assist can compose its panel while Android's lock-screen dismissal is
pending. API 26–30 also lack Android's per-action authentication check for notification buttons.
`android/app/src/main/java/ai/namastex/automagik/AssistActivity.kt:54`
`android/app/src/main/java/ai/namastex/automagik/Notify.kt:68`

## Alternatives considered

| Choice | Proposal | Alternatives |
|---|---|---|
| Default | Off, with a switch in Settings | On by default, requiring an extra step for existing users |
| Authentication | Android screen lock or biometrics where supported | Biometrics only or strong biometrics only, limiting which phones can unlock |
| APIs | Platform prompt on API 30+, system credential screen on API 26–29 | A compatibility library adds a dependency and can vary on older devices |
| Timeout | On process start and after 60 seconds away | Immediate relock, five minutes, a configurable interval, or a timer while on screen |
| Setting changes | Authenticate for both changes | Turn it off without authenticating, allowing anyone with Settings open to disable it |
| Screen lock removed | Keep the cover and link to Android security settings | Turn off the lock automatically or provide only app-storage reset as recovery |
| App content | Compose only the cover while locked | Overlay the running app, leaving dialogs and embedded views to guard separately |
| Notification actions | Show generic text, remove actions, and refuse stale taps | Require only the phone's unlock, allowing replies from an already-unlocked phone |
| Lock-screen setting | Hide it while the app lock is on | Clear the saved preference and make the user set it again |
| Assist | Require phone unlock, then app authentication if due | Show the list while locked, exposing agent details |
| Incoming intents | Prepare pairing and alert state, hold update taps | Hold every intent, or allow the installer over the cover |
| Watch | Keep connections and generic alerts | Pause Watch and lose alerts while locked |
| Recents | Omit screenshots on API 33+, secure windows below 33 | Leave older thumbnails visible or block screenshots on all versions |

## Open questions

- Confirm the 60-second timeout and the loss of notification actions while the app lock is on.
- Confirm the screenshot and screen-sharing trade-off on API 26–32.

## Verification

- Run both flavor tests and lint in the Pocket CI job. The new tests cover policy boundaries,
  prompt ownership, dialog removal, generic alerts, stale actions and selective cancellation.
- On API 26, 29 and 35, set a device PIN and enable the lock through Settings. Cold-start,
  cancel the automatic prompt with Back, and verify that the cover is visible and Home is
  absent. Tap **Unlock**, enter the PIN, and verify Home. Leave for 65 seconds, return to
  the cover, and unlock. Leave for 5 seconds and return to Home. Leave again for 65 seconds
  and open Assist with `am start -n ai.namastex.automagik/.AssistActivity` to check its cover.
  Disable the lock through Settings with the PIN.

## Related

- #244
- [RFC 0009 — Pocket Link key wrapping](0009-keystore-phone-key.md)
- [Privacy policy](../privacy.md)
