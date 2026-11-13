# Worker release pipeline

`.github/workflows/deploy-worker.yml` validates pull requests targeting `main`
and deploys commits pushed to `main` (including merge commits).

## Validation and deployment

Pull requests run type checks, metadata/transform/import tests, a production
build, and `cf deploy --prebuilt --mode production --dry-run`. The dry run
checks the production configuration and upload bundle without publishing a
Worker version. It runs without Cloudflare credentials.

After a change reaches `main`, the workflow checks for deployment credentials
and deploys the same prebuilt output. It does not apply database migrations;
migrations remain a reviewed, separate operation.

## Required GitHub secrets

Configure these repository Actions secrets before merging a change that should
deploy:

- `CLOUDFLARE_API_TOKEN`: scoped to the account and the permissions needed to
  deploy this Worker.
- `CLOUDFLARE_ACCOUNT_ID`: the account containing `photos-api`.

The workflow fails with a clear error if either secret is missing. Do not put
the API token in the repository or workflow file.

## Admin preview safety

Pull requests do not publish a preview Worker. The production Worker config
binds the canonical production D1 database and R2 bucket, so deploying it as a
preview would let admin edits mutate production data. The dry run validates
whether the built Worker is deployable without allowing any preview edits.

An interactive admin preview would need dedicated non-production D1 and R2
resources, their own Cloudflare Access configuration, and disposable seed data.
Add that only as a separate isolated environment; never reuse the production
bindings for preview deployments.
