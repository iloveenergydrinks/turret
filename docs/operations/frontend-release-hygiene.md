# Frontend release hygiene

Keep internal design briefs and review notes in `DESIGN.md` or `.impeccable/`, outside the served application. Do not embed thesis, visual-direction, or finish-review instructions in HTML, templates, client bundles, or hydration data.

Before deploying a frontend release, run:

```sh
node frontend/app/scripts/check-design-notes.mjs PATH_TO_RELEASE/frontend/app/out
```

The standard frontend builds run this gate automatically. Frozen-runtime or additive releases must run it against the final assembled output and include it as a Docker build check after all patches are applied. A failed check blocks release.

For old frozen output, `--write` removes only internal design-note comments; application HTML, React hydration markers, and surrounding serialized values stay intact. Review the changed-file manifest, rerun the check without `--write`, then verify the served production HTML after deployment.

The same gate rejects retired public Dockyard links and known obsolete display copy, including serialized navigation data. Keep service hostnames, contract/ABI names, wallet signing domains, and alert authentication messages intact. When frozen JavaScript changes, publish it under fresh asset URLs and update the page/loader references so cached bundles cannot restore stale links.
