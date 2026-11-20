# WaitlistForm

The interest form on the Cloud page: labelled fields, a consent line, one primary button and a line of fine print.

- Every field has a visible label above it. Optional fields say so in `muted`.
- Fields are `paper` with a `line-2` border; focus shows the `ring` outline.
- Two short fields may share a row; on a phone they stack.
- The consent line says exactly what is stored and why. The form never signs anyone up for marketing.
- While `WHATSAPP_SIGNUPS_OPEN` is off, the preview and the served form offer email only, with the
  email field required. The privacy note's removal form keeps the WhatsApp sender and code choices
  for sign-ups made before the pause. `landing.test.mjs` pins the preview's fields to the served form.
