-- AlterTable
ALTER TABLE "User" ADD COLUMN "disabledAt" DATETIME;

-- CreateTable
CREATE TABLE "InstanceSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
