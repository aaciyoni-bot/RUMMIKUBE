# Local UI checks

Run `npm ci --ignore-scripts` in this directory, then `npm test`.

`npm run check:syntax` parses every inline script in the game and backoffice pages and checks the server and audio JavaScript without connecting to any service.

GitHub Actions runs these checks with Node 20 for pull requests. The Firebase deployment workflow runs the same validation before deploying. GitHub Pages still uses the repository's existing publishing configuration.

The test mounts the actual closed-Rami component in JSDOM with a synthetic Firebase adapter. It checks loading failure/retry, hand rendering, turn controls, and that a cancelled drag never submits a discard. It does not connect to production or prove real-time multiplayer behavior.
