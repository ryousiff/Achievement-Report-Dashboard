-- AlterTable
ALTER TABLE "Client" ADD COLUMN "metaAdAccountId" TEXT;

-- AlterTable
ALTER TABLE "MetaProfile" ADD COLUMN "encryptedSystemToken" TEXT;

-- CreateTable
CREATE TABLE "ClientAdInsightSnapshot" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMP(3),

    CONSTRAINT "ClientAdInsightSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientAdInsightSnapshot_clientId_periodStart_idx" ON "ClientAdInsightSnapshot"("clientId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "ClientAdInsightSnapshot_clientId_metric_periodStart_periodEnd_key" ON "ClientAdInsightSnapshot"("clientId", "metric", "periodStart", "periodEnd");

-- AddForeignKey
ALTER TABLE "ClientAdInsightSnapshot" ADD CONSTRAINT "ClientAdInsightSnapshot_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
