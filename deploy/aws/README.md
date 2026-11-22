# Deploy the transcript service on AWS

A generic recipe for running the HTTP service (with the web page, the job
API and optional sign-in) as one container on ECS Fargate behind an HTTPS
load balancer. Fill in your own account values wherever you see a
`<placeholder>` — nothing here is specific to any deployment.

What you end up with:

```text
https://<your-domain>
        |
   ALB (HTTPS listener, ACM certificate)
        |
   ECS Fargate service — 1+ tasks
   container port 8080, health check /healthz
        |
   secrets: AWS Secrets Manager  |  logs: CloudWatch
```

## Prerequisites

- An AWS account and the `aws` CLI configured for it (`aws sts get-caller-identity`).
- Docker, for the image build.
- A domain you control for HTTPS (any registered domain or subdomain).
- For sign-in: an OAuth 2.0 client (Google Cloud console → Credentials →
  OAuth client ID, type "Web application"). Its client id and secret are
  filled in below.

## Values you fill in

| Placeholder | What it is |
|---|---|
| `<aws-region>` | The region everything is created in, e.g. `us-east-1`. |
| `<aws-account-id>` | Your 12-digit AWS account id (`aws sts get-caller-identity --query Account --output text`). |
| `<your-domain>` | The public HTTPS name the service answers on, e.g. `transcripts.<your-domain>`. |
| `<ecr-repo>` | ECR repository name, e.g. `fisheraiagent`. |
| `<image-tag>` | Image tag, e.g. `v1`. |
| `<secret-name>` | Secrets Manager secret name, e.g. `fisheraiagent/prod`. |
| `<cluster-name>` | ECS cluster name. |
| `<service-name>` | ECS service name. |
| `<vpc-id>` / `<subnet-a>` / `<subnet-b>` | A VPC and two subnets in different AZs for the ALB and the tasks. |
| `<alb-sg>` / `<task-sg>` | Security groups (created in step 4). |
| `<certificate-arn>` | The ACM certificate ARN for `<your-domain>`. |
| `<execution-role-arn>` | `ecsTaskExecutionRole` ARN — the standard AWS-managed execution role, plus permission to read the secret (step 3). |
| `<google-client-id>` | OAuth client id for sign-in. |
| `<google-client-secret>` | OAuth client secret for sign-in. |
| `<session-secret>` | Any long random string; signs the session cookie (`openssl rand -base64 48`). |
| `<service-token>` | Any long random string; required on `/v1` requests as a bearer token (`openssl rand -base64 48`). Skip it to leave the API open. |
| `<tenants-json>` | The tenants document as one line of JSON — the same format as `TENANTS_FILE` in the main README (a top-level tenants array). Optional; omit the key for anonymous-only use. |
| `<google-credentials-json>` | A Google service-account key JSON, one line, only when a tenant uses a `google-drive` destination. |

## 1. Build and push the image

The repo's `Dockerfile` already builds the service; the container listens on
port 8080.

```bash
aws ecr create-repository --repository-name <ecr-repo> --region <aws-region>
aws ecr get-login-password --region <aws-region> \
  | docker login --username AWS --password-stdin <aws-account-id>.dkr.ecr.<aws-region>.amazonaws.com
docker build -t <ecr-repo>:<image-tag> .
docker tag <ecr-repo>:<image-tag> <aws-account-id>.dkr.ecr.<aws-region>.amazonaws.com/<ecr-repo>:<image-tag>
docker push <aws-account-id>.dkr.ecr.<aws-region>.amazonaws.com/<ecr-repo>:<image-tag>
```

## 2. Put the secrets in Secrets Manager

One JSON secret carries everything sensitive; ECS injects each key as an
environment variable. The service also reads `TENANTS_JSON` and
`GOOGLE_CREDENTIALS_JSON` inline, so no files need to be mounted.

```bash
aws secretsmanager create-secret --name <secret-name> --region <aws-region> \
  --secret-string '{
    "SERVICE_TOKEN": "<service-token>",
    "OIDC_CLIENT_ID": "<google-client-id>",
    "OIDC_CLIENT_SECRET": "<google-client-secret>",
    "SESSION_SECRET": "<session-secret>",
    "TENANTS_JSON": "<tenants-json>",
    "GOOGLE_CREDENTIALS_JSON": "<google-credentials-json>"
  }'
```

Leave out any key you do not use: no `OIDC_*`/`SESSION_SECRET` means
anonymous mode; no `TENANTS_JSON` means nothing is saved anywhere; no
`GOOGLE_CREDENTIALS_JSON` only breaks `google-drive` destinations.

The task execution role needs `secretsmanager:GetSecretValue` on this
secret's ARN — attach an inline policy to `<execution-role-arn>`'s role.

## 3. Certificate and load balancer

1. In ACM (same region), request a certificate for `<your-domain>`, validate
   it by DNS, and note `<certificate-arn>`.
2. Create security groups:
   - `<alb-sg>`: inbound 443 from `0.0.0.0/0`.
   - `<task-sg>`: inbound 8080 from `<alb-sg>` only.
3. Create an internet-facing Application Load Balancer in `<vpc-id>` on
   `<subnet-a>` + `<subnet-b>` with `<alb-sg>`.
4. Create a target group: target type `ip`, port `8080`, protocol HTTP,
   health check path `/healthz`.
5. Add an HTTPS listener on 443 with `<certificate-arn>`, default action
   forward to the target group. Optionally redirect 80 → 443.
6. Point `<your-domain>`'s DNS record at the ALB DNS name.

## 4. Task definition and service

Copy `task-definition.template.json` next to this file, replace every
`<placeholder>` (`<aws-account-id>`, `<aws-region>`, `<ecr-repo>`,
`<image-tag>`, `<secret-name>`'s ARN, `<execution-role-arn>`, your domain in
`OIDC_REDIRECT_URI`), then:

```bash
aws logs create-log-group --log-group-name /ecs/<service-name> --region <aws-region>
aws ecs create-cluster --cluster-name <cluster-name> --region <aws-region>
aws ecs register-task-definition --cli-input-json file://task-definition.json --region <aws-region>
aws ecs create-service --cluster <cluster-name> --service-name <service-name> \
  --task-definition <family>:1 --desired-count 1 --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<subnet-a>,<subnet-b>],securityGroups=[<task-sg>],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=<target-group-arn>,containerName=app,containerPort=8080" \
  --region <aws-region>
```

`OIDC_REDIRECT_URI` must be `https://<your-domain>/auth/callback` exactly —
and the same URL must be listed as an authorized redirect URI on the OAuth
client, or sign-in is rejected at the provider.

## 5. Operate

- **Logs:** CloudWatch log group `/ecs/<service-name>` (`aws logs tail
  /ecs/<service-name> --follow`).
- **Update the code:** build, tag and push a new image, then
  `aws ecs update-service --cluster <cluster-name> --service <service-name> --force-new-deployment`.
- **Change tenants or secrets:** update the secret value
  (`aws secretsmanager put-secret-value`), then force a new deployment —
  environment variables only refresh on task start. Tenants changes take
  effect on the next task start; the tenants document itself is re-read on
  every job, so editing it needs no other change.
- **Scale:** `--desired-count` can be raised; sessions are signed cookies
  (no server-side session state) and job state is in-memory per task, so a
  job must be polled on the same task that ran it — acceptable at low
  traffic, or keep the count at 1.
- **Transcript cache:** the container filesystem is ephemeral; the cache is
  a cost optimization only. Attach an EFS volume to `CACHE_DIR` if you want
  it to survive task replacement.

## Notes

- Secrets never live in the image or the task definition — only references
  to the Secrets Manager ARN do.
- The container runs everything the repo ships: web page, `/v1` job API,
  sign-in endpoints. The Discord bot is a separate process and is not part
  of this recipe.
- Keep `SERVICE_TOKEN` set if the API is exposed beyond the web page: the
  `/v1` endpoints otherwise accept any caller's jobs.
- Without `SERVICE_TOKEN` the anonymous job API applies per-client limits
  (`MAX_CONCURRENT_JOBS_PER_CLIENT`, `MAX_JOBS_PER_HOUR_PER_CLIENT`; see the
  main README). Clients are keyed on `CF-Connecting-IP` only when the
  request's peer is in `TRUSTED_PROXY_IPS`. Behind this ALB recipe every
  client's peer is a balancer node, so the whole site shares a few buckets:
  raise the limits, or front the task with a Cloudflare Tunnel and set
  `TRUSTED_PROXY_IPS` to the connector's address (`127.0.0.1,::1` fits a
  cloudflared sidecar in the same task).
