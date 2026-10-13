-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "monthlyReportEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "monthlyReportLastSentMonth" TEXT;

