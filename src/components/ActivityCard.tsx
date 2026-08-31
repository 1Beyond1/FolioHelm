import type { Copy } from "../i18n";
import type { ActivityItem } from "../types";
import type { Language } from "../types";
import { DataStateNotice } from "./DataStateNotice";

interface ActivityCardProps {
  copy: Copy;
  language: Language;
  activity: ActivityItem[];
  onViewAll: () => void;
}

export function ActivityCard({ copy, language, activity, onViewAll }: ActivityCardProps) {
  return (
    <article className="activity-card surface-card" id="orders" data-testid="activity-card">
      <div className="side-heading compact">
        <div><span className="section-kicker">{copy.today}</span><h2>{copy.recentActivity}</h2></div>
        <button className="more-button" type="button" aria-label={copy.moreActivity} onClick={onViewAll}>•••</button>
      </div>
      {activity.length === 0 ? (
        <DataStateNotice language={language} status="no-data" compact />
      ) : (
        <div className="activity-list">
          {activity.map((item) => (
            <div key={`${item.time}-${item.title}`}>
              <i className={`activity-dot ${item.kind}`} />
              <span><b>{item.title}</b><small>{item.detail}</small></span>
              <time>{item.time}</time>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
