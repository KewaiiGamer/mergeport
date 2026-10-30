-- DropIndex
DROP INDEX "Space_repoOwner_repoName_key";

-- AlterTable
ALTER TABLE "Space" ADD COLUMN "backend" TEXT NOT NULL DEFAULT 'GITHUB';
ALTER TABLE "Space" ADD COLUMN "hubSpaceId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Space" ADD COLUMN "hubCursor" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TeamConfig" ADD COLUMN "backend" TEXT NOT NULL DEFAULT 'GITHUB';
ALTER TABLE "TeamConfig" ADD COLUMN "hubOrigin" TEXT;

-- CreateTable
CREATE TABLE "HubSession" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'session',
    "origin" TEXT NOT NULL,
    "cipher" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "login" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Space_backend_repoOwner_repoName_hubSpaceId_key" ON "Space"("backend", "repoOwner", "repoName", "hubSpaceId");
