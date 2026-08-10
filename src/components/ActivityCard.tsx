import type { Copy } from "../i18n";
import type { ActivityItem } from "../types";

interface ActivityCardProps {
  copy: Copy;
  activity: ActivityItem[];
  onViewAll: () => void;
}

export function ActivityCard({ copy, activity, onViewAll }: ActivityCardProps) {
  return (
    <article className="activity-card surface-card" id="orders">
      <div className="side-heading compact">
        <div><span className="section-kicker">{copy.today}</span><h2>{copy.recentActivity}</h2></div>
        <button className="more-button" type="button" aria-label={copy.moreActivity} onClick={onViewAll}>•••</button>
      </div>
      <div className="activity-list">
        {activity.map((item) => (
          <div key={`${item.time}-${item.title}`}>
            <i className={`activity-dot ${item.kind}`} />
            <span><b>{item.title}</b><small>{item.detail}</small></span>
            <time>{item.time}</time>
          </div>
        ))}
      </div>
    </article>
  );
}
