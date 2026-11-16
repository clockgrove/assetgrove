# Release

Assetgrove is published to npm as `@clockgrove/assetgrove`, and from 0.2.0 its optional search as `@clockgrove/assetgrove-search` (`packages/assetgrove-search`). The release workflow (`release.yml`) builds, verifies and attests each tarball; the owner publishes those exact tarballs. Its decisions are under [Packaging](decisions.md#packaging).

## What the release workflow does

The workflow is dispatched by hand on `main`; nothing triggers it otherwise.

- **verify** packs the package once with `pnpm pack`, records the tarball's sha256, runs `npm publish --dry-run` and refuses a version or a Git tag that already exists. It attests the tarball, then installs and runs it on Linux, macOS and Windows with `ASSETGROVE_TEST_TARBALL=<tgz> node --test test/package.test.ts`. It uploads the tarball, its `.sha256` and its attestation as the run's artifact.
- **publish** runs only when the dispatch asks to publish and the package is already on the registry. It needs the `npm-release` environment, whose only reviewer is the owner, and publishes the verified tarball.

The package does not exist on the registry before 0.1.0, so for 0.1.0 the workflow stops after **verify** and the owner publishes by hand, once.

## First publish (0.1.0), by the owner

You need: an npm account that owns the `@clockgrove` scope with two-factor authentication on for writes, the GitHub CLI (`gh`) signed in to the repository, and Node 24.

1. Dispatch `release.yml` on `main` without publish and wait for **verify** to pass on all three systems.
2. Download the run's artifact into an empty directory. `<artifact>` is the artifact's name as the run lists it (`gh run view <run-id> --repo clockgrove/assetgrove` shows it); naming it with `-n` puts its files in the current directory rather than in a directory of that name:

   ```sh
   mkdir assetgrove-0.1.0 && cd assetgrove-0.1.0
   gh run download <run-id> --repo clockgrove/assetgrove -n <artifact>
   ls   # clockgrove-assetgrove-0.1.0.tgz, its .sha256 and the attestation
   ```

   Steps 3 to 5 run in this directory.

3. Check the tarball is the one the run verified and attested:

   ```sh
   sha256sum -c clockgrove-assetgrove-0.1.0.tgz.sha256   # macOS: shasum -a 256 -c
   gh attestation verify clockgrove-assetgrove-0.1.0.tgz --repo clockgrove/assetgrove
   ```

4. Check what it holds: `tar -tzf clockgrove-assetgrove-0.1.0.tgz` lists only `package/package.json`, `package/README.md`, `package/LICENSE` and files under `package/dist/`, `package/skills/` and `package/policy/`, and `package/package.json` says `"version": "0.1.0"`.
5. Sign in and publish the tarball itself, never a fresh pack of a checkout, under the dist-tag `latest`. npm asks for the one-time password from your authenticator; pass it with `--otp` if it does not:

   ```sh
   npm login
   npm publish ./clockgrove-assetgrove-0.1.0.tgz --access public --tag latest
   ```

6. Check the registry: `npm view @clockgrove/assetgrove@0.1.0 version dist-tags` shows `0.1.0` and `latest: 0.1.0`, and `npx @clockgrove/assetgrove@0.1.0 --help --json` prints a document with `"ok": true`.
7. Tag the commit the run built (`git tag v0.1.0 <commit> && git push origin v0.1.0`), so the next **verify** refuses to rebuild this version.

A version on npm cannot be published again. If a step after 5 shows a fault, fix it on `main`, raise the version and release again; `npm deprecate @clockgrove/assetgrove@0.1.0 "<reason>"` marks the bad one.

## Later releases

Raise `version` in `package.json` on `main`, then dispatch `release.yml` with publish. **verify** runs as above; **publish** waits for the owner's approval in the `npm-release` environment and publishes the verified tarball.

## The 0.2.0 release candidate (Phase 2)

Both packages are at `0.2.0`. `pnpm gate --json` lists the Phase 2 gate: each entry's kind (`automated`, `dispatch` or `manual-owner`) and, for each entry that is not automated, the evidence it needs.

- **Core** packs as above. Installed alone it passes `test/package.test.ts`, and its `find` exits 2 `extension_unavailable`: core works without search.
- **Search** packs with `pnpm pack` in `packages/assetgrove-search`. Its `prepack` compiles `src/` to `dist/` (Node does not strip types under `node_modules`), and the tarball holds only `package.json`, `README.md`, `LICENSE`, `dist/` and `skills/`; `assetgrove.entry` is `./dist/extension.js`. `packages/assetgrove-search/test/package.test.ts` checks the listing and imports the packed entry with type stripping off.
- **Skills:** the gate installs `assetgrove` and `assetgrove-search` with `npx skills add` from the repository into a temporary folder and checks every file arrived.
- **Search bars:** the gate reads the latest successful `search-bench.yml` run on `main` that uploaded `search-bench-report`. It fails unless the commit that last changed the bars table in [decisions.md](decisions.md#search-bars-design-section-79) is older than that run, and fails on any bar the report counts as missed; speed bars measured off the reference box are the `search-speed-bars` entry, checked by hand.
- **Publish:** steps 2 to 7 above, once for each tarball (`clockgrove-assetgrove-0.2.0.tgz` and `clockgrove-assetgrove-search-0.2.0.tgz`), the search tarball's listing as the bullet above says, then one tag `v0.2.0`.
