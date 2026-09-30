-- CreateTable
CREATE TABLE "FavoriteGif" (
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "preview" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "url"),
    CONSTRAINT "FavoriteGif_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FavoriteGif_userId_createdAt_idx" ON "FavoriteGif"("userId", "createdAt");
