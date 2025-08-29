import { App, config, Helm, PersistentVolume } from '@homelab/shared'
import { PersistentVolumeClaim, Secret } from '@pulumi/kubernetes/core/v1'
import { Database, Provider } from '@pulumi/postgresql'

const cfg = config('jellyfin')
const ns = cfg.get('namespace', 'jellyfin')

// Create jellyfin-specific media PV pointing to the same NFS share as servarr
const mediaPV = new PersistentVolume('jellyfin-media-pv', {
  metadata: { name: 'jellyfin-media-pv' },
  spec: {
    capacity: { storage: cfg.get('mediaSize', '500Gi') },
    accessModes: ['ReadWriteMany'],
    persistentVolumeReclaimPolicy: 'Retain',
    storageClassName: cfg.get('storageClass', 'truenas-hdd-stripe-nfs'),
    nfs: {
      server: process.env.TRUENAS_HOST || 'localhost', // TrueNAS NFS server (shared with democratic-csi)
      path: process.env.TRUENAS_NFS_PATH_MEDIA || '/path/to/media', // 47TB media collection
    },
  },
})

// Create jellyfin PVC that binds to jellyfin's PV (same NFS share as servarr)
const mediaPVC = new PersistentVolumeClaim(
  'media',
  {
    metadata: { name: 'media', namespace: ns },
    spec: {
      accessModes: ['ReadWriteMany'],
      storageClassName: cfg.get('storageClass', 'truenas-hdd-stripe-nfs'),
      resources: { requests: { storage: cfg.get('mediaSize', '500Gi') } },
      volumeName: 'jellyfin-media-pv',
    },
  },
  { dependsOn: [mediaPV] },
)

// PostgreSQL provider for Jellystat database
const postgresProvider = new Provider('postgres-provider', {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  username: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'defaultpassword',
  sslmode: 'disable',
})

// Create database for Jellystat
new Database(
  'jellystat-database',
  {
    name: 'jfstat',
    owner: process.env.POSTGRES_USER || 'postgres',
  },
  { provider: postgresProvider },
)

// Create secrets for Jellystat
const jellystatSecret = new Secret('jellystat-secret', {
  metadata: {
    name: 'jellystat-secret',
    namespace: ns,
  },
  stringData: {
    'postgres-password': process.env.POSTGRES_PASSWORD || 'defaultpassword',
    'jwt-secret': process.env.JELLYSTAT_JWT_SECRET || 'change-me-please',
  },
})

const jellyfin = new Helm('jellyfin', {
  namespace: ns,
  chart: 'jellyfin',
  repo: 'https://jellyfin.github.io/jellyfin-helm',
  version: process.env.JELLYFIN_HELM_VERSION || 'latest',
  values: {
    image: {
      repository: 'jellyfin/jellyfin',
      tag: process.env.JELLYFIN_IMAGE?.split(':')[1] || '10.10.3',
    },
    service: {
      main: {
        type: 'LoadBalancer',
        ports: {
          http: {
            port: 8096,
          },
        },
      },
    },
    persistence: {
      config: {
        enabled: true,
        type: 'pvc',
        storageClass: cfg.get('storageClass', 'truenas-hdd-mirror-nfs'),
        size: cfg.get('configSize', '2Gi'),
      },
      media: {
        enabled: true,
        type: 'pvc',
        existingClaim: mediaPVC.metadata.name,
        mountPath: '/media',
        subPath: 'media',
      },
    },
    resources: {
      requests: {
        cpu: '500m',
        memory: '1Gi',
      },
      limits: {
        cpu: '2',
        memory: '4Gi',
      },
    },
  },
})

const jellystat = new App('jellystat', {
  namespace: ns,
  image: process.env.JELLYSTAT_IMAGE || 'cyfershepard/jellystat:latest',
  ports: [{ name: 'http', containerPort: 3000, servicePort: 3000 }],
  env: [
    { name: 'POSTGRES_USER', value: process.env.POSTGRES_USER || 'postgres' },
    {
      name: 'POSTGRES_PASSWORD',
      valueFrom: {
        secretKeyRef: {
          name: jellystatSecret.metadata.name,
          key: 'postgres-password',
        },
      },
    },
    { name: 'POSTGRES_IP', value: process.env.POSTGRES_HOST || 'localhost' },
    { name: 'POSTGRES_PORT', value: process.env.POSTGRES_PORT || '5432' },
    { name: 'POSTGRES_DATABASE', value: 'jfstat' },
    {
      name: 'JWT_SECRET',
      valueFrom: {
        secretKeyRef: {
          name: jellystatSecret.metadata.name,
          key: 'jwt-secret',
        },
      },
    },
  ],
  resources: {
    requests: { cpu: '100m', memory: '256Mi' },
    limits: { cpu: '500m', memory: '512Mi' },
  },
  serviceType: 'LoadBalancer',
})

export const namespace = jellyfin.namespace.metadata.name
export const services = {
  jellyfin: jellyfin.release.name,
  jellystat: jellystat.service?.metadata.name,
}
