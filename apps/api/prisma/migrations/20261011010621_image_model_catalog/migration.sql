-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "monthlySpendLimitUsd" DECIMAL(10,4);

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "aiSpendLimitUsd" DECIMAL(10,4),
ADD COLUMN     "preferredImageModelId" TEXT;

-- AlterTable
ALTER TABLE "UsageRecord" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "preferredImageModelId" TEXT;

-- CreateTable
CREATE TABLE "ImageModel" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "family" TEXT NOT NULL DEFAULT '',
    "category" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "falStatus" TEXT,
    "availability" TEXT NOT NULL DEFAULT 'CANDIDATE_UNVERIFIED',
    "source" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "tasks" TEXT[],
    "capabilities" JSONB,
    "inputSchema" JSONB,
    "outputSchema" JSONB,
    "catalogMetadata" JSONB,
    "thumbnailUrl" TEXT,
    "modelUrl" TEXT,
    "commercialUseUrl" TEXT,
    "commercialUseNote" TEXT NOT NULL DEFAULT '',
    "editorialTags" TEXT[],
    "knownLimitations" TEXT NOT NULL DEFAULT '',
    "adminNotes" TEXT NOT NULL DEFAULT '',
    "capabilitiesVerifiedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "lastPriceError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageModelPrice" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "unitPrice" DECIMAL(14,8),
    "unitRaw" TEXT,
    "billingUnit" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "source" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL DEFAULT '',
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "assumptions" JSONB NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageModelPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageGeneration" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "userId" TEXT,
    "jobId" TEXT,
    "comparisonId" TEXT,
    "modelId" TEXT,
    "endpointId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "input" JSONB NOT NULL,
    "settings" JSONB NOT NULL,
    "estimate" JSONB NOT NULL,
    "estimateStatus" TEXT NOT NULL,
    "estimatedCostUsd" DECIMAL(12,6),
    "actualCostUsd" DECIMAL(12,6),
    "actualCostSource" TEXT,
    "billableUnits" DOUBLE PRECISION,
    "requestId" TEXT,
    "assetIds" TEXT[],
    "outputMeta" JSONB,
    "error" TEXT,
    "durationMs" INTEGER,
    "confirmedByUser" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ImageGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelComparison" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "modelIds" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "ratings" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelComparison_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderUsageReport" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "quantity" DOUBLE PRECISION,
    "unit" TEXT,
    "unitPrice" DOUBLE PRECISION,
    "costTotal" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "raw" JSONB NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderUsageReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemState" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemState_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImageModel_endpointId_key" ON "ImageModel"("endpointId");

-- CreateIndex
CREATE INDEX "ImageModel_availability_enabled_idx" ON "ImageModel"("availability", "enabled");

-- CreateIndex
CREATE INDEX "ImageModelPrice_modelId_isCurrent_idx" ON "ImageModelPrice"("modelId", "isCurrent");

-- CreateIndex
CREATE INDEX "ImageGeneration_workspaceId_createdAt_idx" ON "ImageGeneration"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ImageGeneration_projectId_createdAt_idx" ON "ImageGeneration"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ImageGeneration_comparisonId_idx" ON "ImageGeneration"("comparisonId");

-- CreateIndex
CREATE INDEX "ModelComparison_workspaceId_createdAt_idx" ON "ModelComparison"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderUsageReport_provider_endpointId_periodStart_periodE_key" ON "ProviderUsageReport"("provider", "endpointId", "periodStart", "periodEnd");

-- AddForeignKey
ALTER TABLE "ImageModelPrice" ADD CONSTRAINT "ImageModelPrice_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ImageModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageGeneration" ADD CONSTRAINT "ImageGeneration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageGeneration" ADD CONSTRAINT "ImageGeneration_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ImageModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageGeneration" ADD CONSTRAINT "ImageGeneration_comparisonId_fkey" FOREIGN KEY ("comparisonId") REFERENCES "ModelComparison"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelComparison" ADD CONSTRAINT "ModelComparison_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
