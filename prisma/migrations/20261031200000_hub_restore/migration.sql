-- AlterTable
ALTER TABLE "Space" ADD COLUMN "hubCursorOp" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Space" ADD COLUMN "hubEpoch" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "HubRestore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "spaceId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBack" INTEGER NOT NULL,
    "kept" INTEGER NOT NULL,
    "detail" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    CONSTRAINT "HubRestore_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "HubRestore_spaceId_status_idx" ON "HubRestore"("spaceId", "status");
