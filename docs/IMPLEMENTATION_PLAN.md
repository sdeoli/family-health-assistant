# Family Health & Medical Document Assistant — Implementation Plan

Personal, single-family serverless RAG application on AWS, built as hands-on
preparation for the **AWS Certified Generative AI Developer – Professional**
and **AWS Certified Solutions Architect – Professional** exams, with AWS cost
minimized throughout (pay-per-use, destroyable infrastructure).

---

## 1. Design Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Frontend | React/Vite SPA on S3 + CloudFront (OAC) |
| 2 | Authentication | Cognito User Pools + Identity Pools, JWT authorizer on API Gateway |
| 3 | Family-member data isolation | App-level `familyMemberId` partitioning + IAM ABAC (session tags / condition keys) as defense-in-depth |
| 4 | Document ingestion | Pre-signed S3 URLs; S3 event triggers processing |
| 5 | Document extraction | Textract (OCR) → Bedrock LLM structuring into JSON (with page/location metadata) |
| 6 | RAG / vector storage | Hand-rolled: DynamoDB stores embeddings/metadata, Lambda does cosine-similarity retrieval. (Bedrock Knowledge Bases + OpenSearch Serverless treated as a time-boxed, tear-down-after side quest — see Risks.) |
| 7 | Bedrock models | Titan Text Embeddings v2 + Claude Haiku (structuring) / Claude Sonnet (Q&A, summaries) |
| 8 | Application compute | AWS Lambda behind API Gateway (HTTP API) |
| 9 | Async/event-driven processing | Step Functions (Standard) orchestrating Textract → Bedrock → embeddings → DynamoDB, triggered via EventBridge on S3 upload |
| 10 | Primary data store | Single DynamoDB table, single-table design, GSI for time-ordered lab-trend queries |
| 11 | Networking | VPC-less by default; a separate, toggleable IaC module adds private subnets + Interface VPC Endpoints for a time-boxed study session, then gets destroyed |
| 12 | Encryption & secrets | Customer-managed KMS keys for S3 + DynamoDB; no Secrets Manager (no real secrets — IAM/Cognito handle auth) |
| 13 | Observability | CloudWatch + X-Ray distributed tracing + structured correlation-ID logging, plus a custom Bedrock prompt/response/token/latency logging layer |
| 14 | Backup & DR | S3 Versioning + DynamoDB PITR, single-region, manually tested restore |
| 15 | Multi-account strategy | Two accounts (`dev`/`prod`) under AWS Organizations, cross-account CI/CD role assumption |
| 16 | IaC | AWS CDK (TypeScript) |
| 17 | CI/CD | GitHub Actions with OIDC federation into AWS; `dev` on push to `main`, `prod` via manual approval |
| 18 | Testing / evaluation | Bedrock Guardrails on every model call + a hand-built golden-dataset / LLM-as-judge evaluation harness (CI-gated evaluation deferred to phase 2) |
| 19 | Cost controls | AWS Budgets + Cost Anomaly Detection + resource tagging + a one-command `destroy-all` script |

Full rationale/trade-offs for each decision belong in `docs/decisions/` as short ADRs (one per row above) — write these as each phase is built.

---

## 2. Architecture Overview

```
                                   ┌─────────────────────┐
                                   │   Route 53 (opt.)    │
                                   └──────────┬───────────┘
                                              │
                              ┌───────────────▼────────────────┐
                              │  CloudFront (OAC) + S3 (SPA)     │
                              └───────────────┬────────────────┘
                                              │ HTTPS
                    ┌─────────────────────────▼─────────────────────────┐
                    │        Cognito User Pool (JWT) ── Identity Pool     │
                    │              (ABAC session tags: familyMemberId)   │
                    └─────────────────────────┬─────────────────────────┘
                                              │
                              ┌───────────────▼────────────────┐
                              │   API Gateway (HTTP API, JWT authorizer) │
                              └───────────────┬────────────────┘
                                              │
              ┌──────────────┬────────────────┼────────────────┬──────────────┐
              ▼              ▼                ▼                ▼              ▼
        ┌──────────┐  ┌────────────┐   ┌────────────┐  ┌────────────┐  ┌───────────┐
        │ Family   │  │ Presigned  │   │  Ask (RAG)  │  │  Summary   │  │  Timeline │
        │ Members  │  │ URL Lambda │   │   Lambda    │  │   Lambda   │  │ / Trends  │
        │ Lambda   │  │            │   │ (+Guardrails)│  │  Lambda    │  │  Lambda   │
        └────┬─────┘  └─────┬──────┘   └──────┬──────┘  └─────┬──────┘  └─────┬─────┘
             │              │                  │               │               │
             │        ┌─────▼──────┐           │               │               │
             │        │  S3 (docs)  │──ObjectCreated──┐        │               │
             │        │  KMS-CMK    │                 │        │               │
             │        └────────────┘                  ▼        │               │
             │                              ┌───────────────────┐              │
             │                              │  EventBridge rule  │             │
             │                              └─────────┬─────────┘              │
             │                                        ▼                        │
             │                        ┌───────────────────────────────┐        │
             │                        │   Step Functions (Standard)    │        │
             │                        │  Textract → Bedrock Haiku      │        │
             │                        │  (structure) → Titan Embed →   │        │
             │                        │  DynamoDB write                │        │
             │                        └───────────────┬───────────────┘        │
             │                                        │                        │
             └────────────────┬───────────────────────┼────────────────────────┘
                               ▼                       ▼
                    ┌────────────────────────────────────────────┐
                    │   DynamoDB single table (KMS-CMK, PITR)      │
                    │   Families | Members | Documents | LabValues │
                    │   | Embeddings | ChatHistory | EvalLogs      │
                    └────────────────────────────────────────────┘

        Cross-cutting: CloudWatch + X-Ray (traces) · Bedrock Guardrails ·
        Bedrock call logging table · AWS Budgets + Cost Anomaly Detection ·
        AWS Organizations (dev/prod accounts) · GitHub Actions (OIDC) · CDK (TypeScript)

        Optional/toggleable: VPC + Interface Endpoints module (study-only, destroyed after use)
```

### Request/document-processing flow

**Upload/processing:**
1. Frontend requests a pre-signed URL from API Gateway → Lambda (checks ABAC: caller's `familyMemberId` claim matches target prefix).
2. Browser `PUT`s file directly to `s3://docs-bucket/family/{familyId}/member/{memberId}/{docId}`.
3. S3 `ObjectCreated` → EventBridge rule → starts Step Functions execution.
4. Step Functions: Textract (async, callback) → Bedrock Claude Haiku structures raw text/tables into JSON (test name, value, unit, date, page number) → Titan Embed v2 generates chunk embeddings → writes lab values, document metadata, and embeddings into DynamoDB, tagged with source document + page for citations.

**Q&A:**
1. Frontend sends a question to the `Ask` Lambda with the JWT.
2. Lambda embeds the question (Titan), retrieves top matches via cosine similarity over the caller's `familyMemberId` partition in DynamoDB, builds a grounded prompt with retrieved chunks + citations, calls Claude Sonnet through Bedrock Guardrails.
3. Response (with citations) is logged (prompt, response, tokens, latency) to the observability log table, then returned.

**Timeline/trends:** direct DynamoDB `Query` against the `TEST#<type>` GSI, sorted by date — no LLM call needed.

---

## 3. Main AWS Services

| Service | Role | Why chosen |
|---|---|---|
| Cognito | Auth (User Pool + Identity Pool) | Free tier, native JWT authorizer integration, ABAC session tags |
| S3 | Document storage + SPA hosting | $0 idle, pre-signed uploads, versioning for backup |
| CloudFront + OAC | SPA CDN | Cheap global delivery, no server to run |
| API Gateway (HTTP API) | Synchronous API | Cheapest API Gateway type, native JWT auth |
| Lambda | All compute | Pay-per-invoke, $0 idle |
| Step Functions (Standard) | Document processing orchestration | Native async-callback support for Textract, retries, visual debugging |
| Textract | OCR (forms/tables) | Purpose-built for structured medical documents |
| Bedrock (Titan Embed v2, Claude Haiku, Claude Sonnet) | Structuring, embeddings, Q&A, summaries | Tiered model selection for cost/quality; multi-vendor exam exposure |
| Bedrock Guardrails | Safety/PII/grounding checks | Required for medical data; named GenAI exam topic |
| DynamoDB | Single-table store | $0 idle, access-pattern-driven single-table design, PITR |
| KMS (CMK) | Encryption for S3 + DynamoDB | Auditable key usage, ~$2/mo |
| EventBridge | S3 upload → Step Functions trigger | Decoupled event-driven trigger |
| X-Ray | Distributed tracing | Cross-service debugging of the processing pipeline |
| CloudWatch | Logs, metrics, alarms, dashboards | Baseline observability |
| AWS Organizations | dev/prod account separation | Blast-radius isolation, SCPs |
| AWS Budgets + Cost Anomaly Detection | Cost governance | Free, early-warning on runaway spend |
| GitHub Actions (OIDC) | CI/CD | Keyless cross-account deploys, $0 infra |
| AWS CDK (TypeScript) | IaC | Highest Claude-Code fluency, full CFN escape hatches |
| *(study-only)* VPC + Interface Endpoints | Private connectivity pattern | SAP-Pro networking practice without ongoing NAT/endpoint cost |

---

## 4. Repository Structure

```
family-health-assistant/
├── infra/                          # CDK TypeScript
│   ├── bin/app.ts
│   ├── lib/
│   │   ├── stages/app-stage.ts
│   │   ├── stacks/
│   │   │   ├── auth-stack.ts
│   │   │   ├── data-stack.ts             # DynamoDB + KMS
│   │   │   ├── storage-stack.ts          # S3 (docs + frontend) + KMS
│   │   │   ├── api-stack.ts
│   │   │   ├── processing-stack.ts       # Step Functions + task Lambdas
│   │   │   ├── frontend-stack.ts         # CloudFront + OAC
│   │   │   ├── observability-stack.ts
│   │   │   ├── cost-governance-stack.ts
│   │   │   └── network-study-stack.ts    # toggleable, not in default deploy
│   │   └── constructs/
│   └── test/
├── services/
│   ├── api/{family-members,documents,ask,summary,timeline}/
│   ├── processing/{start-textract,structure-with-bedrock,embed-and-store}/
│   └── shared/{auth-context,dynamo-client,bedrock-client,logging}/
├── frontend/                       # React/Vite SPA
├── eval/
│   ├── golden-dataset/qa-pairs.json
│   └── run-eval.ts                 # LLM-as-judge harness
├── scripts/{destroy-all.sh,bootstrap-accounts.sh}
├── .github/workflows/{deploy-dev.yml,deploy-prod.yml}
└── docs/{architecture.md,decisions/*.md}   # one ADR per decision in section 1
```

---

## 5. Implementation Phases

| Phase | Focus | GenAI concepts practiced | SAP-Pro concepts practiced | Example Claude Code tasks |
|---|---|---|---|---|
| 0 | Foundations: Organizations (dev/prod), CDK bootstrap, GitHub OIDC + Actions skeleton, Budgets + Cost Anomaly Detection, tagging | — | Multi-account design, OIDC federation, SCPs, cost governance | "Scaffold a CDK app with a Stage construct parameterized by environment"; "write the GitHub OIDC trust policy and Actions workflow for cross-account deploy" |
| 1 | Identity & data foundation: Cognito, DynamoDB single table + GSI + KMS, ABAC IAM policy, family-member CRUD API | — | IAM ABAC, KMS key policies, DynamoDB single-table design | "Design the single-table access patterns and generate the CDK table+GSI definition"; "write the ABAC IAM policy condition and Identity Pool role mapping" |
| 2 | Document ingestion: S3 (KMS+versioned), pre-signed URL Lambda, EventBridge on upload | — | S3 security (OAC, bucket policies), event-driven triggers | "Write the pre-signed PUT URL Lambda scoped to the caller's familyMemberId prefix"; "write the EventBridge rule to start Step Functions on S3 upload" |
| 3 | Extraction & structuring: Step Functions (Textract → Bedrock Haiku → Titan embeddings → DynamoDB) | Document processing pipelines, prompt engineering, embeddings generation, tiered model selection | Step Functions service integrations, async callback pattern, error/retry handling | "Write the Step Functions ASL with a Textract callback task token"; "write the Bedrock Haiku prompt that structures Textract output into lab-value JSON with page citations" |
| 4 | RAG & Q&A: retrieval Lambda, `Ask` endpoint, Guardrails, citation prompt | RAG architecture, retrieval logic, grounded generation, citations, Guardrails config, prompt engineering | — | "Implement cosine-similarity retrieval scoped to familyMemberId"; "write the grounded Q&A prompt requiring inline citations"; "configure a Bedrock Guardrail with PII redaction and grounding threshold" |
| 5 | Frontend: SPA (upload, timeline/trend charts, chat with citations), CloudFront + OAC | Presenting grounded answers + citations in UX | CloudFront/OAC, S3 static hosting security | "Build the upload flow (pre-signed URL, PUT, poll status)"; "build a chat UI that renders citation links back to document pages" |
| 6 | Evaluation & Guardrails hardening: golden dataset, LLM-as-judge harness | Evaluation methodology, golden datasets, LLM-as-judge, regression detection | — | "Write an LLM-as-judge scoring script comparing answers against golden answers on correctness/groundedness" |
| 7 | Observability: X-Ray, structured logging, Bedrock call logging table, dashboards/alarms | LLM observability (tokens, cost-per-query, latency) | Distributed tracing, centralized logging, alarming | "Instrument all Lambdas with X-Ray and a correlation-ID logging wrapper"; "add a Bedrock client wrapper logging prompt/response/tokens/latency" |
| 8 | Resilience/backup: DynamoDB PITR + S3 Versioning, restore drill | — | Backup/restore strategy, RTO/RPO | "Write a restore-drill script that restores the table to a point-in-time and verifies row counts" |
| 9 | Networking deep-dive (study-only): VPC + Interface Endpoints, inspect, destroy | — | VPC design, Gateway vs. Interface endpoints, PrivateLink, security groups | "Write the CDK construct for private subnets + Interface VPC Endpoints for Bedrock/Textract/Cognito"; "write a Flow Logs query proving traffic never leaves the VPC" |
| 10 | Cost governance & lifecycle polish: `destroy-all.sh`, tagging audit, docs | Reviewing Bedrock spend by model/task tier | Cost allocation tags, Cost Explorer, resource lifecycle management | "Write a destroy-all script tearing down stacks in reverse dependency order"; "generate a cost-by-tag report query" |

---

## 6. 15-Day Schedule

Assumes ~2–4 focused hours/day. Heavier phases get 2 days; lighter ones share a day.

| Day | Phase | Focus | End-of-day deliverable |
|---|---|---|---|
| 1 | 0a | AWS Organizations: create `dev`/`prod` accounts, CDK bootstrap both, base tagging convention | Two accounts exist, `cdk bootstrap` succeeds in both |
| 2 | 0b | GitHub OIDC trust roles, Actions pipeline skeleton, AWS Budgets + Cost Anomaly Detection | Empty CDK app deploys to `dev` via GitHub Actions on push to `main` |
| 3 | 1a | Cognito User Pool + Identity Pool, DynamoDB single-table design + KMS CMK | You can sign up/log in via Cognito hosted UI; table + GSI deployed |
| 4 | 1b | ABAC IAM policy (session-tag condition), family-member CRUD API | Create/list family members via API; cross-member access verified denied |
| 5 | 2 | S3 buckets (KMS + versioning), pre-signed URL Lambda, EventBridge rule on upload | A file PUT to S3 via pre-signed URL fires an EventBridge event |
| 6 | 3a | Step Functions skeleton + Textract async job + callback handling | Execution graph shows Textract completing and returning raw text/tables |
| 7 | 3b | Bedrock Haiku structuring prompt + Titan embeddings + DynamoDB write | Uploading a real lab report produces structured lab-value rows + embeddings |
| 8 | 4a | Cosine-similarity retrieval Lambda over DynamoDB (scoped to `familyMemberId`) | Given a question, retrieval returns the right chunks from test documents |
| 9 | 4b | `Ask` endpoint: grounded prompt + citations + Bedrock Guardrails | A question returns a Sonnet answer with a citation; a denied-topic test is blocked |
| 10 | 5a | Frontend scaffold (Vite/React), Cognito login, upload flow | You can log in and upload a document from the browser |
| 11 | 5b | Lab-trend charts, chat UI with clickable citations, CloudFront + OAC deploy | Full SPA live on a CloudFront URL, timeline and chat both functional |
| 12 | 6 | Golden Q&A dataset (~20–30 pairs) + LLM-as-judge harness, Guardrails tuning | Eval script outputs a score; a deliberate bad change causes a measurable drop |
| 13 | 7 | X-Ray tracing, correlation-ID logging, Bedrock call logging table, CloudWatch dashboard | One end-to-end request traceable in X-Ray; dashboard shows Bedrock cost/latency |
| 14 | 8 + 9 | PITR/Versioning restore drill; deploy/inspect/destroy the VPC + Interface Endpoints study module | Documented RTO from a real restore; Flow Logs/X-Ray proof of PrivateLink traffic, module destroyed |
| 15 | 10 | `destroy-all.sh`, tagging audit, Cost Explorer-by-tag review, ADRs finalized, DoD checklist | `dev` torn down to near-zero cost and rebuilt clean from `main`; all 19 decisions documented |

**Pacing notes:**
- Days 6–9 (extraction + RAG) are highest-risk-of-slipping — Textract/Bedrock integration and prompt tuning tend to take longer than expected. Borrow a 16th day from here if needed, rather than compressing Day 12 (eval) or Day 14 (DR/networking), since those two are most exam-relevant.
- Day 14 combines two unrelated phases only because both are "deploy, verify, tear down" exercises — treat them as two separate blocks, not one merged debugging session.
- Day 15 has the most slack; absorb overruns there first.

---

## 7. Cost-Saving Measures
- 100% pay-per-request compute/storage (Lambda, DynamoDB on-demand, S3, API Gateway HTTP API) — no idle floors in the default deploy.
- No OpenSearch Serverless (would cost $175–350/mo minimum) — hand-rolled DynamoDB vector search instead.
- No VPC/NAT/Interface Endpoints in default deploy — study module deployed and destroyed on demand.
- Tiered Bedrock model use (Haiku for bulk structuring, Sonnet only for Q&A/summaries).
- Two accounts, but both fully serverless — no duplicated always-on cost from the dev/prod split.
- Budgets + Cost Anomaly Detection catch runaway spend early; `destroy-all.sh` zeroes out non-prod between sessions.

## 8. Expected Monthly Cost (single user, light use)

| Item | Estimate |
|---|---|
| Lambda, API Gateway, EventBridge, Step Functions | ~$0 (free tier covers this volume) |
| S3 storage + requests | ~$0.10–0.50 |
| DynamoDB (on-demand + PITR) | ~$0.50–1 |
| KMS (2 CMKs) | ~$2 |
| Textract (pages processed) | ~$0.50–2 |
| Bedrock (Titan embeddings + Haiku + Sonnet, light volume) | ~$1–4 |
| CloudFront + Cognito | ~$0 (free tiers) |
| Budgets/Anomaly Detection/GitHub Actions | $0 |
| **Total (default deploy)** | **~$5–10/mo** |
| + Networking study module, only while deployed | +~$1–2/day (destroy after use) |
| + Second (dev) account, same workloads | roughly doubles the above while both are up |

## 9. Architecture Risks & Trade-offs to Understand
- **DynamoDB hand-rolled vector search doesn't scale** past a few thousand chunks — fine for one family, but know exactly when/why you'd migrate to Bedrock Knowledge Bases + OpenSearch Serverless, and what that migration costs.
- **No VPC by default** means Bedrock/Textract/Cognito calls traverse AWS's public service endpoints (IAM-authenticated, not public internet) — understand why this trade-off is acceptable here but wouldn't be with a private database in the mix.
- **Single-region only** — a full region outage means downtime until manual redeploy; know what Global Tables/CRR would have cost and why it wasn't proportionate here.
- **ABAC session tags add a subtle failure mode** — a misconfigured Identity Pool role mapping could cause false-deny (annoying) or false-allow (dangerous); needs an explicit test case, not "it worked once."
- **LLM-as-judge evaluation has known blind spots** — a judge model can share the generator's blind spots; treat golden-dataset scores as signal, not ground truth.
- **Guardrails contextual grounding checks aren't perfect** — a well-formed but subtly wrong citation can still pass; you are the last line of review for a medical-data app.
- **Cross-account CI/CD OIDC trust policies are a real security surface** — a missing `repo:` claim restriction can let any GitHub repo assume your deploy role.

## 10. Definition of Done
- A family member profile can be created and documents uploaded, processed end-to-end without manual intervention.
- Lab trends render correctly from real uploaded data via DynamoDB queries (no LLM call).
- A natural-language question returns an answer with at least one accurate citation, correctly filtered to the selected family member (cross-member access verified denied).
- Guardrails demonstrably blocks at least one denied-topic/PII test case.
- The golden-dataset eval harness runs and produces a groundedness/correctness score comparable across a prompt change.
- `destroy-all.sh` brings the dev account to near-zero billable resources, and a full redeploy from `main` via GitHub Actions restores it.
- A DynamoDB PITR restore has been performed at least once successfully into a scratch table.
- The networking study module has been deployed, inspected, documented, and destroyed.
- Monthly AWS bill for the default (non-study) deployment stays under ~$10.
- Every decision in Section 1 has a corresponding one-paragraph ADR under `docs/decisions/`.
