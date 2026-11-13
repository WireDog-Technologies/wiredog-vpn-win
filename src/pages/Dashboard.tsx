import React from 'react';
import USMap from '@/components/dashboard/USMap';
import SubscriptionCard from '@/components/SubscriptionCard';
import RevokedBanner from '@/components/RevokedBanner';

const Dashboard: React.FC = () => {
  return (
    <div className="h-full relative">
      <USMap />
      {/* Each renders only for its own case: no active plan, or a staff-revoked account. */}
      <div className="absolute top-3 left-3 right-3 z-30">
        <SubscriptionCard />
        <RevokedBanner />
      </div>
    </div>
  );
};

export default Dashboard;
