# Yormun_Executor

Único proceso autorizado a hablar con Kubernetes (AGENTS.md 5.3, BLUEPRINT 4.2). Ejecuta código LLM-generado en pods Deno efímeros bajo demanda, sin warm pool. Ver `../Yormun_Docs/` para la documentación canónica (BLUEPRINT, AGENTS, ADR 0003).

## Setup

```bash
nvm use                # Node 24 (.nvmrc)
pnpm install
```

En desarrollo local necesitas apuntar a un clúster K8s real (kubeconfig) o a K3s local:

```bash
export KUBECONFIG_PATH=~/.kube/config   # o el path a tu kubeconfig de desarrollo
pnpm run start:dev
```

En producción no se setea `KUBECONFIG_PATH`: el Executor usa el ServiceAccount montado del pod (`kubeConfig.loadFromCluster()`).

## Qué hace (Fase 2.3)

- **`src/rbac/`** — whitelist estática de tools (`tool-whitelist.ts`, propia del Executor, no la de Core) + `RbacValidatorService`: ninguna tool corre sin pasar por aquí (403 si no está en la whitelist).
- **`src/k8s/k8s.service.ts`** — único punto de contacto con `@kubernetes/client-node` en todo el proyecto. `namespace` se fija una vez al construir el servicio; ningún método acepta un namespace como parámetro — estructuralmente no puede tocar otro namespace que `agents-sandbox`.
- **`src/k8s/pod-spec.builder.ts`** — construye el pod. Usa `deno run` (nunca `eval`: en Deno 2.9 `eval` tiene acceso implícito a *todos* los permisos, ignora `--allow-net` — ver ADR 0003). El código llega como un `data:` URL en base64, un solo argv de Kubernetes — nunca pasa por una shell.
- **`src/pod-lifecycle/`** — ciclo de vida bajo demanda: crea el pod, espera con timeout (+ `activeDeadlineSeconds` como respaldo a nivel de clúster), recoge logs, y **siempre** destruye el pod.
- **`src/modal/`** — stub explícito para `remote: true` (501). El cliente real de Modal llega en Fase 5.
- **`POST /execute`** — `{ tool, code, env, timeout, remote }`, validado con Zod en el borde.

## Tests

Tres niveles (AGENTS.md 6):

```bash
pnpm test              # unitarios — rápidos, sin Docker
pnpm test:integration  # K3s real vía testcontainers (@testcontainers/k3s) — requiere Docker
pnpm test:e2e           # e2e del árbol completo de Nest
```

Los tests de integración levantan un clúster K3s real, pre-pullean las imágenes que van a usar (Deno tarda >100s sin pre-pull en un containerd anidado — mismo problema que motiva el pre-pull de producción en Yormun_Infra), y verifican **de verdad** que un pod en `agents-sandbox` no puede alcanzar un servicio en `yormun` — no un mock del cliente de Kubernetes. Ver ADR 0003 para el razonamiento completo.

## Pendiente (coordinar PR en Yormun_Infra)

El ServiceAccount del Executor necesita, además de `create/get/list/delete` de Pods (BLUEPRINT 4.2), permiso para `create/delete` de `networkpolicies` en `agents-sandbox` — necesario para que el mecanismo de whitelist de egreso por tool (hoy sin tools que lo activen) pueda aplicarse cuando exista una. Ver ADR 0003 punto 3.

## Contrato OpenAPI

```bash
pnpm generate:contract  # emite contracts/openapi.json — lo consume Yormun_Core
```
