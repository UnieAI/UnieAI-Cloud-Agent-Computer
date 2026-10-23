import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGeneratedIngressPlan,
  discoverServicesFromManifest,
  resolveGeneratedIngressServiceLabel
} from "./onprem-generated-ingress.mjs";

const manifest = `
apiVersion: v1
kind: Service
metadata:
  name: unieai-demo-api
  namespace: sandbox
spec:
  ports:
    - name: http
      port: 80
      targetPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: demo-worker
  namespace: sandbox
spec:
  ports:
    - name: http
      port: 8080
      targetPort: 8080
`;

test("resolveGeneratedIngressServiceLabel shortens known project prefixes", () => {
  assert.equal(
    resolveGeneratedIngressServiceLabel({ serviceName: "unieai-demo-api", projectSlug: "demo" }),
    "api"
  );
  assert.equal(
    resolveGeneratedIngressServiceLabel({ serviceName: "unieai-api", projectSlug: "demo" }),
    "api"
  );
  assert.equal(
    resolveGeneratedIngressServiceLabel({ serviceName: "demo-worker", projectSlug: "demo" }),
    "worker"
  );
  assert.equal(
    resolveGeneratedIngressServiceLabel({ serviceName: "custom-service", projectSlug: "demo" }),
    "custom-service"
  );
});

test("discoverServicesFromManifest generates {service}.{project} hostnames by default", () => {
  const discovery = discoverServicesFromManifest(manifest, {
    projectSlug: "demo",
    dnsWildcardDomain: "*.apps.example.test"
  });

  assert.deepEqual(discovery.hostnames, [
    "api.demo.apps.example.test",
    "worker.demo.apps.example.test"
  ]);
  assert.deepEqual(
    discovery.services.map((service) => service.serviceLabel),
    ["api", "worker"]
  );
});

test("discoverServicesFromManifest uses the release namespace when manifests omit metadata.namespace", () => {
  const releaseScopedManifest = `
apiVersion: v1
kind: Service
metadata:
  name: unieai-demo-api
spec:
  ports:
    - name: http
      port: 80
      targetPort: 8080
`;
  const discovery = discoverServicesFromManifest(releaseScopedManifest, {
    projectSlug: "demo",
    dnsWildcardDomain: "*.apps.example.test",
    defaultNamespace: "unieai-demo"
  });

  assert.equal(discovery.services[0]?.namespace, "unieai-demo");
});

test("buildGeneratedIngressPlan honors custom service labels", () => {
  const discovery = discoverServicesFromManifest(manifest, {
    projectSlug: "demo",
    dnsWildcardDomain: "*.apps.example.test"
  });
  const plan = buildGeneratedIngressPlan(discovery, {
    releaseName: "unieai-demo",
    chartName: "demo",
    ingressClassName: "traefik",
    clusterIssuerName: "letsencrypt-prod",
    generatedIngressConfig: {
      services: [
        {
          name: "unieai-demo-api",
          namespace: "sandbox",
          ingressEnabled: true,
          serviceLabel: "frontend",
          selectedPort: {
            name: "http",
            port: 80
          }
        }
      ]
    }
  });

  assert.deepEqual(plan.hostnames, [
    "frontend.demo.apps.example.test",
    "worker.demo.apps.example.test"
  ]);
  assert.equal(
    plan.services.find((service) => service.name === "unieai-demo-api")?.serviceLabel,
    "frontend"
  );
});

test("buildGeneratedIngressPlan reports duplicate hostnames instead of silently suffixing", () => {
  const discovery = discoverServicesFromManifest(manifest, {
    projectSlug: "demo",
    dnsWildcardDomain: "*.apps.example.test"
  });
  const plan = buildGeneratedIngressPlan(discovery, {
    releaseName: "unieai-demo",
    chartName: "demo",
    ingressClassName: "traefik",
    clusterIssuerName: "letsencrypt-prod",
    generatedIngressConfig: {
      services: [
        {
          name: "unieai-demo-api",
          namespace: "sandbox",
          ingressEnabled: true,
          serviceLabel: "shared",
          selectedPort: {
            name: "http",
            port: 80
          }
        },
        {
          name: "demo-worker",
          namespace: "sandbox",
          ingressEnabled: true,
          serviceLabel: "shared",
          selectedPort: {
            name: "http",
            port: 8080
          }
        }
      ]
    }
  });

  assert.equal(plan.routableServiceCount, 0);
  assert.deepEqual(plan.hostnames, []);
  assert.equal(plan.resourceBodies.length, 0);
  assert.equal(plan.validationErrors.length, 1);
  assert.match(plan.validationErrors[0], /duplicate hostname shared\.demo\.apps\.example\.test/i);
  assert.ok(plan.services.every((service) => service.validationError));
});
