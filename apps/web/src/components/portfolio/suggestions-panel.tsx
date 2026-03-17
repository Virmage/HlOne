"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, Info, TrendingDown, DollarSign } from "lucide-react";

interface SuggestionsPanelProps {
  suggestions: string[];
}

function getSuggestionIcon(suggestion: string) {
  if (suggestion.includes("exposure") || suggestion.includes("diversi"))
    return <AlertTriangle className="h-4 w-4 text-yellow-400 shrink-0" />;
  if (suggestion.includes("idle capital") || suggestion.includes("$"))
    return <DollarSign className="h-4 w-4 text-[var(--hl-green)] shrink-0" />;
  if (suggestion.includes("declined") || suggestion.includes("drawdown"))
    return <TrendingDown className="h-4 w-4 text-red-400 shrink-0" />;
  return <Info className="h-4 w-4 text-blue-400 shrink-0" />;
}

export function SuggestionsPanel({ suggestions }: SuggestionsPanelProps) {
  if (suggestions.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Suggestions</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {suggestions.map((s, i) => (
            <div
              key={i}
              className="flex items-start gap-3 rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] p-3"
            >
              {getSuggestionIcon(s)}
              <p className="text-sm text-[var(--hl-text)]">{s}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
