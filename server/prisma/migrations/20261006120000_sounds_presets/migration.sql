-- CreateTable
CREATE TABLE "Sound" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "guildId" TEXT,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "image" TEXT,
    "path" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Sound_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Sound_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VoicePreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "guildId" TEXT,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "params" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoicePreset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VoicePreset_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Sound_ownerId_idx" ON "Sound"("ownerId");

-- CreateIndex
CREATE INDEX "Sound_guildId_idx" ON "Sound"("guildId");

-- CreateIndex
CREATE INDEX "VoicePreset_ownerId_idx" ON "VoicePreset"("ownerId");

-- CreateIndex
CREATE INDEX "VoicePreset_guildId_idx" ON "VoicePreset"("guildId");
