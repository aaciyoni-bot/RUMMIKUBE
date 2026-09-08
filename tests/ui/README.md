# Local UI checks

Run `npm install` in this directory, then `npm test`.

The test mounts the actual closed-Rami component in JSDOM with a synthetic Firebase adapter. It checks loading failure/retry, hand rendering, turn controls, and that a cancelled drag never submits a discard. It does not connect to production or prove real-time multiplayer behavior.
