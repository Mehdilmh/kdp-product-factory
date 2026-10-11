-- CreateTable
CREATE TABLE "ColoringBook" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "theme" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "ageRange" TEXT NOT NULL DEFAULT '',
    "difficulty" TEXT NOT NULL DEFAULT 'EASY',
    "illustrationTarget" INTEGER NOT NULL,
    "seriesName" TEXT NOT NULL DEFAULT '',
    "seriesNumber" INTEGER,
    "styleProfile" JSONB NOT NULL,
    "styleProfileId" TEXT,
    "modelId" TEXT,
    "interiorSettings" JSONB NOT NULL,
    "qcThresholds" JSONB NOT NULL,
    "budgetCapUsd" DECIMAL(10,4),
    "metadataExtras" JSONB NOT NULL DEFAULT '{}',
    "stage" TEXT NOT NULL DEFAULT 'SETUP',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ColoringBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColoringStyleProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ColoringStyleProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColoringPage" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "concept" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "negativePrompt" TEXT NOT NULL DEFAULT '',
    "promptVersion" TEXT NOT NULL DEFAULT '',
    "promptEdited" BOOLEAN NOT NULL DEFAULT false,
    "modelId" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "referenceAssetIds" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "currentVersionId" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "qcOverride" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ColoringPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColoringPageVersion" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "generationId" TEXT,
    "prompt" TEXT NOT NULL DEFAULT '',
    "negativePrompt" TEXT NOT NULL DEFAULT '',
    "modelId" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "originalAssetId" TEXT NOT NULL,
    "processedAssetId" TEXT,
    "processing" JSONB,
    "qc" JSONB,
    "dhash" TEXT,
    "estimatedCostUsd" DECIMAL(12,6),
    "actualCostUsd" DECIMAL(12,6),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ColoringPageVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ColoringBook_projectId_key" ON "ColoringBook"("projectId");

-- CreateIndex
CREATE INDEX "ColoringBook_workspaceId_updatedAt_idx" ON "ColoringBook"("workspaceId", "updatedAt");

-- CreateIndex
CREATE INDEX "ColoringBook_workspaceId_stage_idx" ON "ColoringBook"("workspaceId", "stage");

-- CreateIndex
CREATE INDEX "ColoringStyleProfile_workspaceId_name_idx" ON "ColoringStyleProfile"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "ColoringPage_bookId_position_idx" ON "ColoringPage"("bookId", "position");

-- CreateIndex
CREATE INDEX "ColoringPage_bookId_status_idx" ON "ColoringPage"("bookId", "status");

-- CreateIndex
CREATE INDEX "ColoringPageVersion_generationId_idx" ON "ColoringPageVersion"("generationId");

-- CreateIndex
CREATE UNIQUE INDEX "ColoringPageVersion_pageId_version_key" ON "ColoringPageVersion"("pageId", "version");

-- AddForeignKey
ALTER TABLE "ColoringBook" ADD CONSTRAINT "ColoringBook_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColoringBook" ADD CONSTRAINT "ColoringBook_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColoringStyleProfile" ADD CONSTRAINT "ColoringStyleProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColoringPage" ADD CONSTRAINT "ColoringPage_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "ColoringBook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColoringPageVersion" ADD CONSTRAINT "ColoringPageVersion_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "ColoringPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
