-- Place of a sound within its section (dragged in the soundboard).
ALTER TABLE "Sound" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
